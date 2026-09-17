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

  /** The still-image bytes of an entry, preferring the embedded EXIF preview. */
  stillBlob(entry, { preferThumb = true } = {}) {
    const still = entry.result?.still;
    const file = entry.file;
    if (preferThumb && still?.thumb?.len > 0) {
      return file.slice(still.thumb.off, still.thumb.off + still.thumb.len);
    }
    if (still?.length > 0) return file.slice(0, Math.min(still.length, file.size));
    // No usable metadata: hand over the whole file. The browser stops at the
    // end of the image, and for HEIC the whole file *is* the image.
    if (file.size <= 64 * 1024 * 1024) return file;
    return null;
  }

  /**
   * Decodes a downscaled thumbnail into `canvas`.
   * @returns {Promise<'ok'|'unsupported'|'skipped'>}
   */
  async thumbnail(entry, canvas, width) {
    if (entry.status === 'failed' || !entry.result) return 'skipped';
    if (entry.thumbState === 'unsupported') return 'unsupported';
    const blob = this.stillBlob(entry);
    if (!blob) return 'skipped';
    const token = entry.id;
    await this.#schedule(token);
    if (entry.__thumbCancelled) return 'skipped';
    try {
      let bitmap;
      try {
        bitmap = await createImageBitmap(blob, {
          resizeWidth: width,
          resizeQuality: THUMB_QUALITY,
          imageOrientation: 'from-image',
        });
      } catch {
        // Older engines reject the options bag or the orientation keyword.
        bitmap = await createImageBitmap(blob, { resizeWidth: width });
      }
      drawContained(canvas, bitmap);
      bitmap.close?.();
      return 'ok';
    } catch {
      entry.thumbState = 'unsupported';
      return 'unsupported';
    } finally {
      this.#release();
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

/** Draws a bitmap into a canvas, letterboxed, without upscaling past 2x. */
function drawContained(canvas, bitmap) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, cw, ch);
  const scale = Math.min(cw / bitmap.width, ch / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const x = Math.round((cw - w) / 2);
  const y = Math.round((ch - h) / 2);
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(bitmap, x, y, w, h);
}
