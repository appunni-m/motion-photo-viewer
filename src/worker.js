/**
 * Scan worker.
 *
 * A worker owns one WASM instance and the whole per-file read loop, so the UI
 * thread never touches file bytes. The loop is bounded on purpose: at most a few
 * small windows per file, and growth only when the core asks for it.
 *
 * Reads are `File.slice().arrayBuffer()`, which reads just those bytes from
 * disk. Nothing is cached, nothing is persisted, and no file is ever read in
 * full.
 */

import { MotionPhotoCore, mergeStages } from './wasm.js';

const corePromise = MotionPhotoCore.load();

/** Budget per file. Keeps a pathological file from becoming unbounded work. */
export const LIMITS = {
  headBytes: 64 * 1024,
  tailBytes: 64 * 1024,
  maxHeadBytes: 1024 * 1024,
  maxTailBytes: 2 * 1024 * 1024,
  maxWindowBytes: 512 * 1024,
  maxReads: 6,
  maxBytes: 6 * 1024 * 1024,
};

async function readRange(file, off, len) {
  const end = Math.min(off + len, file.size);
  if (end <= off) return new Uint8Array(0);
  return new Uint8Array(await file.slice(off, end).arrayBuffer());
}

/**
 * Scans one file to a final answer.
 * @returns {Promise<{result: object, stats: object}>}
 */
export async function scanFile(file, options = {}) {
  const core = await corePromise;
  const limits = { ...LIMITS, ...options };
  const size = file.size;
  const started = performance.now();
  const stats = { reads: 0, bytesRead: 0, passes: 0, windows: 0, waitMs: 0 };

  const charge = (buf) => {
    stats.reads += 1;
    stats.bytesRead += buf.byteLength;
    return buf;
  };
  const wait = (t0) => {
    stats.waitMs += performance.now() - t0;
  };

  if (size === 0) {
    return { result: emptyResult(size), stats };
  }

  let headBytes = Math.min(limits.headBytes, size);
  let tailBytes = Math.min(limits.tailBytes, size);
  let head = null;
  let tail = null;
  let result = null;
  let windowReads = 0;

  for (let pass = 0; pass < 8; pass += 1) {
    if (stats.reads >= limits.maxReads || stats.bytesRead >= limits.maxBytes) break;

    // A file smaller than both windows is read once, in full, as the head.
    const whole = size <= limits.headBytes + limits.tailBytes;
    const wantHead = whole ? size : headBytes;
    const wantTail = whole ? 0 : tailBytes;

    if (!head || head.byteLength < wantHead) {
      const t0 = performance.now();
      head = charge(await readRange(file, 0, wantHead));
      wait(t0);
    }
    if (wantTail > 0 && (!tail || tail.byteLength < wantTail)) {
      const off = Math.max(head ? head.byteLength : 0, size - wantTail);
      const t0 = performance.now();
      tail = charge(await readRange(file, off, size - off));
      wait(t0);
    }

    stats.passes += 1;
    result = core.probe({ head, tail, fileSize: size });
    if (result.plan || !result.readMore) break;

    const more = result.readMore;
    if (more.target === 'head') {
      const next = Math.min(more.bytes || 0, limits.maxHeadBytes);
      if (next <= (head ? head.byteLength : 0)) break;
      headBytes = next;
      continue;
    }
    if (more.target === 'tail') {
      const next = Math.min(more.bytes || 0, limits.maxTailBytes);
      if (next <= (tail ? tail.byteLength : 0)) break;
      tailBytes = next;
      continue;
    }
    if (more.target === 'window') {
      if (windowReads >= 2 || stats.reads >= limits.maxReads) break;
      windowReads += 1;
      const off = Math.max(0, more.off | 0);
      const len = Math.min(more.bytes || limits.maxWindowBytes, limits.maxWindowBytes, size - off);
      const t0 = performance.now();
      const win = charge(await readRange(file, off, len));
      wait(t0);
      const prepared = core.prepare({
        region: { off: more.regionOff, len: more.regionLen },
        w1: { bytes: win, off },
        w2: tail ? { bytes: tail, off: size - tail.byteLength } : null,
        fileSize: size,
      });
      // Keep what stage 1 learned about the file, take the plan from stage 2.
      result = mergeStages(result, prepared);
      if (result.plan || !result.readMore) break;
      // A second window request means "read further into the video"; one more
      // pass is allowed, then the driver reports what it found.
      continue;
    }
    break;
  }

  stats.ms = performance.now() - started;
  return { result: result ?? emptyResult(size), stats };
}

function emptyResult(size) {
  return {
    ok: true,
    kind: 'unknown',
    container: 'unknown',
    fileSize: size,
    still: null,
    motion: null,
    plan: null,
    readMore: null,
    meta: {},
    markers: [],
    boxes: [],
    notes: ['file was not read'],
  };
}

self.onmessage = async (event) => {
  const { id, type, file, options } = event.data ?? {};
  try {
    if (type === 'scan') {
      const { result, stats } = await scanFile(file, options);
      self.postMessage({ id, ok: true, result, stats });
      return;
    }
    if (type === 'preload') {
      await corePromise;
      self.postMessage({ id, ok: true });
      return;
    }
    self.postMessage({ id, ok: false, error: `unknown message: ${type}` });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
