Everything runs on the device. There is no server, no upload, no cache and no
thumbnail store: detection and extraction happen in a dependency-free
WebAssembly module that declares **zero imports**, so it cannot reach the network
even in principle.

**What it opens**

- **Samsung** motion photos: the SEFT trailer at the end of the file states the
  video's exact byte range — including the 12-byte `mpv2` pointer newer devices
  write — for both JPEG and the two HEIC layouts Samsung uses.
- **Google / Motion Photo 1.0**: the XMP `Container:Directory` for JPEGs, and the
  top-level `mpvd` box for HEIC and AVIF stills.
- **HEIF video items**, the item-based reading of the specification, kept as a
  fallback.
- **iPhone and Google Live Photo pairs**, matched by file name.
- Anything else is listed as a still or a video and never mistaken for motion.

**What that costs**

Scanning reads a 64 kB header and a 64 kB trailer per file, plus at most one
192 kB window when a video header is needed. A real 8 MB Galaxy photo is fully
resolved by reading **4.1%** of it, and every real camera file checked so far
extracts as a single verbatim slice — the camera's own MP4, byte for byte.

**Verified, not asserted**

- Three genuine Samsung files from a public corpus, resolved to the exact byte
  ranges recovered independently with ExifTool and ffprobe, plus a Galaxy M34
  capture checked the same way.
- Byte-exact extraction for every supported shape, and ffprobe validation
  wherever a file has to be rebuilt instead.
- Hostile input — noise, truncation, absurd box sizes, lying metadata — returns
  a decision and never traps.
- In a headless browser: motion photos, Live Photos and plain videos classified
  correctly, EXIF rotation honoured in tiles and viewer alike, and **no request
  leaving the origin**.

The attached `motion_photo_wasm.wasm` is built from this tag by the release
workflow, after the full gate passes; `BUILD.txt` records its digest and size.
