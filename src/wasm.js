/**
 * Thin loader for the Rust/WebAssembly core.
 *
 * The module uses a raw ABI (no wasm-bindgen, no imports, no glue to keep in
 * sync). This file only marshals buffers in and JSON out; every byte-level
 * decision lives in the Rust crate.
 */

const WASM_URL = new URL('../wasm/motion_photo_wasm.wasm', import.meta.url);

export class MotionPhotoCore {
  #exports;
  #decoder = new TextDecoder();

  constructor(exports) {
    this.#exports = exports;
  }

  /** Instantiates the module, preferring the streaming path. */
  static async load(url = WASM_URL) {
    let instance;
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`wasm fetch failed: ${response.status}`);
        ({ instance } = await WebAssembly.instantiateStreaming(response, {}));
        return new MotionPhotoCore(instance.exports);
      } catch {
        // GitHub Pages and file:// servers do not always send
        // `application/wasm`; fall through to the buffer path.
      }
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`wasm fetch failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
    return new MotionPhotoCore(instance.exports);
  }

  /** Copies caller-provided views into WASM memory, runs `fn`, frees them. */
  #withBuffers(specs, fn) {
    const held = [];
    try {
      for (const spec of specs) {
        const view = spec?.bytes;
        const len = view ? view.byteLength : 0;
        if (!len) {
          held.push({ ptr: 0, len: 0 });
          continue;
        }
        const ptr = this.#exports.mp_alloc(len);
        // Re-derive the view each time: an allocation may have grown memory
        // and detached earlier ArrayBuffer objects.
        new Uint8Array(this.#exports.memory.buffer, ptr, len).set(view);
        held.push({ ptr, len });
      }
      return fn(held.map((h) => h.ptr));
    } finally {
      for (const h of held) {
        if (h.ptr) this.#exports.mp_free(h.ptr, h.len);
      }
    }
  }

  #readResult(ptr) {
    if (!ptr) throw new Error('wasm returned a null result');
    const memory = this.#exports.memory.buffer;
    const len = new DataView(memory).getUint32(ptr, true);
    const text = this.#decoder.decode(new Uint8Array(memory, ptr + 4, len));
    this.#exports.mp_free_result(ptr);
    return JSON.parse(text);
  }

  /**
   * Stage 1: identify a file and locate its motion payload.
   * @param {{head?: Uint8Array, tail?: Uint8Array, fileSize: number}} input
   */
  probe({ head, tail, fileSize }) {
    const ptr = this.#withBuffers([{ bytes: head }, { bytes: tail }], (p) =>
      this.#exports.mp_probe(
        p[0],
        head ? head.byteLength : 0,
        p[1],
        tail ? tail.byteLength : 0,
        fileSize,
      ),
    );
    return this.#readResult(ptr);
  }

  /**
   * Stage 2: finish the plan for a known video byte range using a window the
   * caller read at (or around) that range.
   */
  prepare({ region, w1, w2, fileSize }) {
    const ptr = this.#withBuffers([{ bytes: w1?.bytes }, { bytes: w2?.bytes }], (p) =>
      this.#exports.mp_prepare(
        region.off,
        region.len,
        p[0],
        w1?.bytes ? w1.bytes.byteLength : 0,
        w1?.off ?? 0,
        p[1],
        w2?.bytes ? w2.bytes.byteLength : 0,
        w2?.off ?? 0,
        fileSize,
      ),
    );
    return this.#readResult(ptr);
  }
}

/** Decodes the base64 literals a plan may contain. */
export function decodeLiteral(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Turns a plan into a `Blob`.
 *
 * Literal parts are a few hundred bytes of synthesized headers; media parts are
 * `File.slice()` views. Building the Blob therefore does not read or copy the
 * media: the browser references the same bytes on disk.
 */
export function planToBlob(file, plan) {
  if (!plan?.parts?.length) return null;
  const parts = plan.parts.map((part) => {
    if (part.t === 'lit') return decodeLiteral(part.b64);
    return file.slice(part.off, part.off + part.len);
  });
  return new Blob(parts, { type: plan.mime || 'video/mp4' });
}

/**
 * Combines the two stages into one coherent answer.
 *
 * Stage 1 sees the head and the tail, so it knows the container, the metadata
 * and which route identified the video. Stage 2 reads a window at that video
 * range, so it knows the plan. Neither alone describes the file, and the driver
 * only ever shows the merged result.
 */
export function mergeStages(first, second) {
  if (!first) return second;
  if (!second) return first;
  const motion = { ...(first.motion ?? {}) };
  // Stage 2 only read the video bytes, so it describes the *file* far less well
  // than stage 1 did. Its generic labels must not replace a specific route.
  const descriptive = new Set(['family', 'method', 'confidence']);
  const known = (value) => value !== null && value !== undefined && value !== 'unknown' && value !== 'none';
  for (const [key, value] of Object.entries(second.motion ?? {})) {
    if (value === null || value === undefined) continue;
    // Stage 1's route description always wins: it saw the whole shape.
    if (descriptive.has(key) && known(motion[key])) continue;
    motion[key] = value;
  }
  // Whether a plan exists is stage 2's verdict, and it always has the last word.
  motion.playable = second.motion?.playable ?? motion.playable;
  motion.reason = second.motion?.reason ?? null;
  return {
    ...first,
    ...second,
    container: second.container && second.container !== 'unknown' ? second.container : first.container,
    still: second.still ?? first.still,
    meta: second.meta && Object.values(second.meta).some(Boolean) ? second.meta : first.meta,
    markers: second.markers?.length ? second.markers : first.markers,
    boxes: second.boxes?.length ? second.boxes : first.boxes,
    notes: [...(first.notes ?? []), ...(second.notes ?? [])],
    motion,
    readMore: second.readMore ?? null,
  };
}
