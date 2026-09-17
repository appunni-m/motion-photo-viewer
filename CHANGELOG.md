# Changelog

## 0.1.1

Fixes found by pointing the viewer at a real photo library.

- **HEIC dimensions were a tile's, not the picture's.** An iPhone HEIC of
  1402×1363 is a grid of 512×512 tiles, and taking the first `ispe` property
  reported 512×512. Dimensions now come from the primary item's `ispe`, resolved
  through `ipma`, with the largest property as a fallback for files whose
  association table cannot be read. Verified against ExifTool on three iPhone
  files.
- **macOS metadata appeared as tiles.** A folder copied off a Mac carries an
  AppleDouble file for every picture (`._IMG_3207.heic`, 4 kB of resource fork)
  with the extension of an image. In one real folder 33 of 66 "media" files were
  these. They are now skipped, as are `.DS_Store`, `Thumbs.db`, `desktop.ini` and
  the Spotlight and fseventsd directories.
- **A fixed bug could stay visible.** The service worker served the app
  cache-first, so after a deploy the browser kept running the previous
  JavaScript and WebAssembly until the cache was cleared — which is how a HEIC
  that had been misclassified as a motion photo kept showing a play button. The
  worker is now network-first with the cache as its offline fallback, so a
  deploy takes effect on the next load and the app still works offline.
- **Plain videos carried no metadata**, because the container route returned
  before reading the `moov`. Codec, size and duration are now reported, which is
  what lets a Live Photo's failure name its companion's codec.
- **A Live Photo failure now names the companion file and its codec** instead of
  a generic message, for both the tile and the inspector.

## 0.1.0

First release. A folder of pictures goes in; every motion picture in it comes
out, with the embedded clip playable and the whole thing running on the device.

### Formats

- **Samsung SEFT trailer** — the `MotionPhoto_Data` block states the video's
  exact byte range, including the 12-byte `mpv2` offset/size record newer
  devices write. Covers the Galaxy JPEG layout and both Samsung HEIC layouts
  (a top-level `sefd` box, and `mpvd` holding `[MP4][sefd]`).
- **Motion Photo 1.0** — the XMP `Container:Directory` for JPEG, and the
  top-level `mpvd` box for HEIC and AVIF stills.
- **HEIF video items** — `iinf`/`iloc` extents with the `cdsc` reference, as a
  fallback for the item-based reading of the specification.
- **Appended containers** and a **sample-table rebuild** for files with no
  metadata at all, patching `stco`/`co64` and copying the sample span verbatim.
- **Live Photo pairs** for iPhone and Google exports, matched by file name.
- Plain stills and videos are classified as such — a plain HEIC is never
  mistaken for a motion photo, whatever its HEVC image tiles look like.

### Reading and extraction

- Detection never reads a whole file. A 64 kB header and a 64 kB trailer per
  file, plus at most one 192 kB window on request; a real 8 MB Galaxy photo is
  resolved by reading 4.1% of it.
- Extraction is a verbatim `File.slice()` of the camera's own MP4 for every real
  camera file checked. Media bytes never enter WebAssembly memory and are never
  written anywhere.
- Thumbnails decode only for tiles on screen, two at a time; the clip is
  assembled only when you press play.

### Fixed after the first deployment

- **HEVC clips were refused before being tried.** Codec strings were malformed —
  RFC 6381 wants the profile compatibility flags bit-reversed, and the set bit
  indices were printed instead, producing `hvc1.1.30.29.L120.…` which no browser
  parses. Playback is no longer gated on `canPlayType` either: the clip is always
  attempted and the browser's own error produces the explanation.
- **EXIF orientation was honoured unevenly.** Tiles now decode through the same
  `<img>` path as the viewer, and an embedded IFD1 preview is rotated by the main
  image's tag. Drawing also centred thumbnails half a box off.
- **The sticky filter bar sat on top of the grid** — translucent backgrounds, a
  margin-based gap, and a `height: 100%` body that capped the sticky context at
  one viewport.
- **Two motion photos handed the decoder the whole file** because their still
  length was never derived, so the picture plus hundreds of kilobytes of clip
  went to the image decoder.

### Verification

43 Rust unit tests, 56 deterministic checks driving the module from Node, real
ffmpeg-encoded fixtures validated with ffprobe, the three-sample public camera
corpus plus a Galaxy M34 capture checked byte-for-byte against ranges recovered
with ExifTool, and a headless browser suite that fails if any request leaves the
origin.
