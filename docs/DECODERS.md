# Still decoders for formats browsers lack

The viewer draws pictures through the browser, always. That path is native, fast
and free: JPEG, PNG, WebP and AVIF everywhere, plus HEIC in Safari.

It fails for exactly one common format: **HEIC outside Safari**. A HEIC still is
an H.265/HEVC intra frame, and Chrome and Firefox ship no HEVC decoder. No amount
of container parsing changes that, which is why the viewer says so plainly instead
of showing a broken tile.

A decoder module fills that gap. It is optional, it is never in the default
bundle, and it is never used without the reader asking for it.

## The contract

Drop a module at `decoders/<id>.js` in the repository root. `make package-pages`
copies the directory and declares what it found in the page
(`<meta name="motion-photo-decoders" content="hevc">`), so an installation without
one never fetches a file that is not there.

```js
// decoders/hevc.js
export default async function createDecoder() {
  const wasm = await WebAssembly.instantiateStreaming(fetch('./hevc_bg.wasm'));
  return {
    name: 'hevc',
    /**
     * @param {Uint8Array} bytes the picture's own bytes - for HEIF, the whole
     *        file, because tiles live in `mdat` and are addressed by `iloc`
     * @param {{container: string, width?: number, height?: number, name: string}} info
     * @returns {Promise<{width: number, height: number, rgba: Uint8ClampedArray}>}
     */
    async decode(bytes, info) {
      const { width, height, rgba } = await wasm.decode_heic(bytes);
      return { width, height, rgba };
    },
  };
}
```

Rules the viewer relies on:

| | |
| --- | --- |
| Pixels | `rgba` is RGBA8, `width * height * 4` bytes, no row padding |
| Order | top-left first, already rotated and mirrored as the file's properties require |
| Errors | throw; the viewer falls back to its explanation and stays usable |
| Cost | called on the main thread, once per picture, only after a click; a slow decode is acceptable, a blocking one is not - yield inside long loops |
| State | one module instance is reused for every picture and for tiles afterwards |

The viewer does the rest: `decoderFor()` in `src/decoder.js` loads the module on
demand, `PreviewService.decodeStill()` turns the frame into an `ImageBitmap`, and
the viewer and the grid draw it through the same code path they use for an `<img>`.

## What an HEVC still decoder has to do

This is the work for a project like
[`image-slash-star`](https://github.com/appunni-m/image-slash-star), whose AVIF
support is AV1 and therefore no help here. It is a real decoder, not a wrapper
around one, unless you accept an LGPL dependency (see below).

**Bitstream**

- VPS/SPS/PPS, reached through the `hvcC` record that HEIF stores as an item
  property (find the property through `iprp`/`ipco`/`ipma`).
- Profile and level: Main and Main 10 cover phone cameras; tier matters for level.
- Bit depth 8 and 10, chroma 4:2:0 at least; 4:2:2 and 4:4:4 appear in editing
  exports. CTU sizes 16/32/64, and `pic_width_in_luma_samples` rounded up to the
  CTU grid.

**Decoding**

- Quadtree CTU partitioning, coding-unit and transform-tree recursion.
- Intra prediction: planar, DC, and the 33 angular modes; reference sample
  substitution, strong/weak intra smoothing.
- Residual: 4×4 DST for intra luma, 4×4–32×32 DCT, scaling lists, quantisation.
- In-loop filters: deblocking (boundary strength, bS tables, both chroma and
  luma) and SAO (band and edge offset, per-CTU merge).
- Entry points: WPP and tiles, including dependent slice segments. WPP is used by
  most hardware encoders, so it cannot be skipped in practice.
- PCM blocks: rare, but a conforming stream may contain them.

**HEIF plumbing, which a generic HEVC decoder does not have**

- `iloc` for each item's extents: decode the item's bytes, not the file's.
- **`grid` items**: the primary item of a phone HEIC is usually a grid, whose
  payload is `version | flags | rows-1 | columns-1 | output width | output height`
  as big-endian `u16`s, followed by the tile item IDs. Decode each tile and blit
  it in row-major order, cropping the right and bottom edges. Skip this and a
  4032×3024 photograph arrives as nine 512×512 tiles.
- `ispe` for the output size, `irot`/`imir` for orientation - both are item
  properties, associated through `ipma`, not EXIF tags.
- Ignore `auxl`-referenced items (depth, alpha, gain maps) and the `Exif`/`XMP`
  items; they are referenced by `cdsc` and are not pictures.

**A sensible first cut**: 8-bit 4:2:0, Main profile, intra-only, one slice per
tile, no PCM, no scaling lists, no dependent slices, WPP and tiles supported.
That is what every phone camera emits, and it is already a large amount of code.

## Building and installing one

```sh
# 1. Build the decoder as a wasm module plus a tiny JS wrapper.
cargo build --release --target wasm32-unknown-unknown

# 2. Put the wrapper and the module where the viewer looks for them.
mkdir -p decoders
cp target/wasm32-unknown-unknown/release/hevc.wasm decoders/hevc_bg.wasm
cp js/hevc-wrapper.js decoders/hevc.js

# 3. Check it end to end, in the browser suite, against a real file.
make package-pages
node scripts/check-real-samples.mjs --local ~/Pictures/IMG_0001.heic
make verify-browser
```

Sizes to expect: a from-scratch HEVC intra decoder is 300–600 kB of wasm before
optimisation; `libde265` is about the same and comes with its licence.

## Testing the plumbing without a decoder

`tests/stub-decoder.js` is a module that ignores its input and returns a fixed
frame. The browser suite serves it at `/decoders/hevc.js` and asserts that

- nothing is promised when no decoder is installed,
- the native path is still tried first,
- an installed decoder is *offered*, not used unasked,
- the frame reaches the viewer canvas and, afterwards, the grid tiles.

A real decoder replaces the stub without any change to the viewer.

## Licensing

The viewer is MIT. A decoder is a separate file with its own licence, and the
default bundle contains none.

- **`libde265` / `libheif`** decode HEIC today and are **LGPL-3.0**. Shipping them
  means shipping their source or a written offer, a notice, and keeping them
  separable so a reader can rebuild them - which a separate `decoders/` file
  does. Check this against your own distribution before relying on it.
- **A permissive decoder of your own** avoids the question entirely, which is the
  reason to write one.
