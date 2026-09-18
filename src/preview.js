/**
 * Preview bytes on demand.
 *
 * Two rules keep this cheap:
 *
 * 1. Nothing is decoded until a tile is actually on screen, and only two
 *    decodes run at once.
 * 2. Media reaching the DOM is always a `Blob` assembled from `File.slice()`
 *    parts, so the browser streams from the original file. The only exception
 *    is the header bytes the WASM core synthesizes for rebuilds, which are a
 *    few hundred bytes.
 */

import { decoderLoaded, decodeStill } from './decoder.js';
import { planToBlob } from './wasm.js';

const THUMB_QUALITY = 'low';

export class PreviewService {
  #queue = [];
  #running = 0;
  #concurrency = 2;
  #videoUrls = new Map();
  #stillUrls = new Map();
  #maxUrls = 6;

  constructor({ concurrency = 2, maxUrls = 6 } = {}) {
    this.#concurrency = concurrency;
    this.#maxUrls = maxUrls;
  }

  /**
   * The still-image bytes of an entry, preferring the embedded EXIF preview.
   * @returns {{blob: Blob, isThumb: boolean}|null}
   */
  stillSource(entry, { preferThumb = true } = {}) {
    const still = entry.result?.still;
    const file = entry.file;
    if (preferThumb && still?.thumb?.len > 0) {
      return { blob: file.slice(still.thumb.off, still.thumb.off + still.thumb.len), isThumb: true };
    }
    // A short still slice means the metadata was wrong; a real picture is
    // always longer, and the whole file is the safer fallback.
    if (still?.length >= 128) {
      return { blob: file.slice(0, Math.min(still.length, file.size)), isThumb: false };
    }
    // No usable metadata: hand over the whole file. The browser stops at the
    // end of the image, and for HEIC the whole file *is* the image.
    if (file.size <= 64 * 1024 * 1024) return { blob: file, isThumb: false };
    return null;
  }

  stillBlob(entry, options) {
    return this.stillSource(entry, options)?.blob ?? null;
  }

  /**
   * Draws a thumbnail into `canvas`.
   *
   * The picture is decoded through an `<img>` rather than `createImageBitmap`,
   * for one reason: EXIF orientation. Every engine applies it to an `<img>`,
   * and that is also what the viewer uses, so a tile and the picture it opens
   * can never disagree. `createImageBitmap` is not consistent about it - Chrome
   * applies the rotation even when asked not to, other engines honour the
   * option - which produces a sideways tile next to an upright picture, or a
   * sideways embedded preview next to an upright one.
   *
   * @returns {Promise<'ok'|'unsupported'|'skipped'>}
   */
  async thumbnail(entry, canvas, width) {
    if (entry.status === 'failed' || !entry.result) return 'skipped';
    // Remembered failure, unless the reader has since opted into module
    // decoding - that is a second chance, not the same attempt again.
    const moduleCanHelp = entry.decodeWithModule && decoderLoaded();
    if (entry.thumbState === 'unsupported' && !moduleCanHelp) return 'unsupported';
    const source = this.stillSource(entry);
    if (!source) return 'skipped';

    await this.#schedule(entry.id);
    const url = URL.createObjectURL(source.blob);
    try {
      const image = new Image();
      image.style.imageOrientation = 'from-image';
      image.decoding = 'async';
      image.src = url;
      await image.decode();
      drawContained(canvas, image, rotationFor(entry, source.isThumb));
      return 'ok';
    } catch {
      // The engine cannot draw this one - a HEIC in Chrome, most often. An
      // installed decoder gets a turn, but only once the reader has asked for
      // one: decoding photographs in WebAssembly is worth a click, not a
      // surprise on every tile.
      if (moduleCanHelp) {
        const frame = await this.decodeStill(entry);
        if (frame) {
          drawContained(canvas, frame, 1);
          entry.thumbState = 'ok';
          return 'ok';
        }
      }
      entry.thumbState = 'unsupported';
      return 'unsupported';
    } finally {
      URL.revokeObjectURL(url);
      this.#release();
    }
  }

  /**
   * Decodes an entry's picture with an installed module.
   * @returns {Promise<ImageBitmap|null>}
   */
  async decodeStill(entry) {
    const source = this.stillSource(entry);
    if (!source) return null;
    const container = entry.result?.container ?? 'unknown';
    const frame = await decodeStill(container, new Uint8Array(await source.blob.arrayBuffer()), {
      width: entry.result?.still?.width,
      height: entry.result?.still?.height,
      name: entry.name,
    });
    if (!frame) return null;
    try {
      // An ImageBitmap behaves like the <img> the rest of the code draws, so
      // the viewer and the tiles share one drawing path.
      return await createImageBitmap(new ImageData(frame.rgba, frame.width, frame.height));
    } catch {
      return null;
    }
  }

  #schedule(token) {
    if (this.#running < this.#concurrency) {
      this.#running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push({ token, resolve });
    });
  }

  #release() {
    const next = this.#queue.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.#running = Math.max(0, this.#running - 1);
  }

  /** Full-resolution still as an object URL, for the viewer. */
  stillUrl(entry) {
    const cached = this.#stillUrls.get(entry.id);
    if (cached) return cached;
    const blob = this.stillBlob(entry, { preferThumb: false });
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.#trim(this.#stillUrls, this.#maxUrls);
    this.#stillUrls.set(entry.id, url);
    return url;
  }

  /**
   * The extracted motion video as an object URL.
   *
   * The plan comes from WASM: either one verbatim `File.slice()` of a
   * self-contained MP4, or a rebuild whose large part is still a verbatim
   * slice. No media bytes are copied through JavaScript or WASM memory.
   */
  videoUrl(entry) {
    const cached = this.#videoUrls.get(entry.id);
    if (cached) return cached;
    const plan = entry.live
      ? { mime: 'video/mp4', direct: true, parts: [{ t: 'slice', off: 0, len: entry.live.entry.file.size }] }
      : entry.result?.plan;
    if (!plan) return null;
    const source = entry.live ? entry.live.entry.file : entry.file;
    const blob = planToBlob(source, plan);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.#trim(this.#videoUrls, this.#maxUrls);
    this.#videoUrls.set(entry.id, url);
    return url;
  }

  /** True when the browser is likely able to decode this entry's video. */
  canPlay(entry) {
    const codec = entry.result?.motion?.codec ?? (entry.live ? 'avc1' : null);
    if (!codec) return '';
    const probe = document.createElement('video');
    const short = codec.split('.')[0];
    const type = `video/mp4; codecs="${codec}"`;
    return probe.canPlayType(type) || probe.canPlayType(`video/mp4; codecs="${short}"`);
  }

  #trim(map, max) {
    while (map.size >= max) {
      const [key, url] = map.entries().next().value;
      URL.revokeObjectURL(url);
      map.delete(key);
    }
  }

  release(entry) {
    const video = this.#videoUrls.get(entry.id);
    if (video) {
      URL.revokeObjectURL(video);
      this.#videoUrls.delete(entry.id);
    }
    const still = this.#stillUrls.get(entry.id);
    if (still) {
      URL.revokeObjectURL(still);
      this.#stillUrls.delete(entry.id);
    }
  }

  clear() {
    for (const url of this.#videoUrls.values()) URL.revokeObjectURL(url);
    for (const url of this.#stillUrls.values()) URL.revokeObjectURL(url);
    this.#videoUrls.clear();
    this.#stillUrls.clear();
    this.#queue = [];
  }
}

/**
 * The rotation to apply on top of what the engine already did.
 *
 * A full still carries the camera's Orientation tag, and every engine applies it
 * to an `<img>`, so nothing more is needed. An embedded preview thumbnail
 * usually carries *no* orientation tag of its own - it is a copy of the stored
 * pixels - so the engine has nothing to apply and the tile would sit sideways
 * next to an upright picture. That is the case this function exists for.
 */
function rotationFor(entry, isThumb) {
  if (!isThumb) return 1;
  const meta = entry.result?.meta ?? {};
  const own = entry.result?.still?.thumb?.orientation ?? meta.thumbOrientation;
  if (own && own !== 1) return 1; // the preview carries its own tag: the engine wins
  return meta.orientation ?? 1;
}

/** Draws an image source into a canvas, letterboxed, centred, and oriented. */
function drawContained(canvas, source, orientation = 1) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, cw, ch);

  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  if (!sw || !sh) return;

  const swap = orientation >= 5 && orientation <= 8;
  const dispW = swap ? sh : sw;
  const dispH = swap ? sw : sh;
  const scale = Math.min(cw / dispW, ch / dispH);
  const w = Math.max(1, Math.round(dispW * scale));
  const h = Math.max(1, Math.round(dispH * scale));

  ctx.save();
  // The box is centred on the canvas, so the transform origin is the canvas
  // centre - not the centre plus half the box.
  ctx.translate(Math.round(cw / 2), Math.round(ch / 2));
  switch (orientation) {
    case 2: ctx.scale(-1, 1); break;
    case 3: ctx.rotate(Math.PI); break;
    case 4: ctx.scale(1, -1); break;
    case 5: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break;
    case 6: ctx.rotate(Math.PI / 2); break;
    case 7: ctx.rotate(-Math.PI / 2); ctx.scale(1, -1); break;
    case 8: ctx.rotate(-Math.PI / 2); break;
    default: break;
  }
  ctx.imageSmoothingQuality = 'low';
  // After a quarter turn the drawn rectangle's own axes are swapped.
  if (swap) ctx.drawImage(source, -h / 2, -w / 2, h, w);
  else ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.restore();
  // Recorded so the layout can be asserted from a test without guessing at
  // pixels: what was drawn, from what, and with which orientation applied.
  canvas.dataset.drawn = `${w}x${h}`;
  canvas.dataset.source = `${sw}x${sh}`;
  canvas.dataset.orientation = String(orientation);
}
