/**
 * A stub still decoder, used by the browser suite to prove the decoder path.
 *
 * It is not a codec: it ignores the bytes and returns a fixed frame. That is the
 * point - the test is about the plumbing (discovery, install, opt-in, drawing),
 * which must work before a real HEVC decoder exists to plug in.
 *
 * It is served by `scripts/browser-smoke.mjs` at `/decoders/hevc.js`; it is never
 * part of the assembled site.
 */

export default async function createDecoder() {
  return {
    name: 'stub',
    /**
     * @param {Uint8Array} bytes the still's bytes, ignored here
     * @returns {{width: number, height: number, rgba: Uint8ClampedArray}}
     */
    async decode(bytes) {
      const width = 64;
      const height = 48;
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = 255; // magenta: nothing in the fixtures is this colour
        rgba[i + 1] = 0;
        rgba[i + 2] = 255;
        rgba[i + 3] = 255;
      }
      return { width, height, rgba, bytesRead: bytes?.length ?? 0 };
    },
  };
}
