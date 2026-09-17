# How detection works

This is the byte-level reference for the WebAssembly core in
`crates/motion-photo-wasm`. It documents what the code actually does, what has
been verified, and where the uncertainty is.

Everything here runs against small **windows** of a file, never the whole file.
A window is a contiguous byte range read with `File.slice()`; the core sees a
`Sparse` (see `src/bits.rs`), which resolves absolute file offsets into whichever
window contains them and reports `None` for anything outside every window. A
parser therefore never needs the whole file to *decide* something, and the
driver only grows a window when the core explicitly asks.

## The reading model

| Window | Default | Grown to | Purpose |
| --- | --- | --- | --- |
| head | 64 kB | 1 MB | container sniff, JPEG segments, EXIF, XMP, HEIF `meta` |
| tail | 64 kB | 2 MB | appended `ftyp`, trailer `moov` |
| window | — | 512 kB | one targeted read at a video range the metadata named |

Budgets per file: 6 reads and 6 MB (24 MB in a deep scan). A file smaller than
both windows is read exactly once, in full, which is cheaper than two reads.
The scan driver is `src/worker.js`; the same loop is reproduced in
`scripts/verify.mjs` so the tests exercise the production protocol.

## Detection order

`probe()` in `src/probe.rs` tries these routes in order and stops at the first
one that yields a playable plan. The order matters: the structural routes are
both cheaper and more trustworthy than the metadata ones, and some writers put
metadata in these files that is simply wrong (see the S22 note below).

### 1. Container sniff

| Test | Container |
| --- | --- |
| `FF D8 FF` | JPEG |
| `ftyp` at offset 4 | ISOBMFF; the major brand at offset 8 splits it into HEIF (`heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`, `mif1`, `msf1`), AVIF (`avif`, `avis`) or a plain video (`isom`, `mp4*`, `qt  `, …) |
| `89 50 4E 47` | PNG |
| `RIFF` + `WEBP` at 8 | WebP |
| `GIF8` | GIF |
| `II*\0` / `MM\0*` | TIFF |

A plain video brand ends the work immediately: `kind: "video"`, the plan is one
slice of the whole file. This is what keeps MP4s from being reported as motion
photos.

### 2. Samsung SEFT trailer (any container)

Every motion photo written by a Samsung camera ends with a trailer Samsung calls
SEFT, and the trailer sits *after* the video. Two consequences: "video = the last
N bytes" is wrong by the size of the trailer, and a box-chain walk that must end
at EOF will not find the video either. The trailer states the video's exact
extent, so it is read first (`src/seft.rs`).

Layout, all lengths little-endian, from the end of the file backwards:

```text
... blocks ...                          each block:
SEFH | u32 version | u32 count             u16 0x0000
  count x 12 bytes:                        u16le type
    u16 0x0000 | u16le type                u32le nameLen
    u32le negOffset | u32le size           name bytes
u32le contentLen | "SEFT"                  payload (size - 8 - nameLen bytes)
```

`contentLen` is the size of the SEFH directory — its 12-byte header plus 12 bytes
per entry — and the 8-byte footer follows it, so `dirPos = file_size - 8 -
contentLen`. A block's position is `dirPos - negOffset`. Both readings are tried,
because being wrong here costs a whole detection route.

Worked example, a real Galaxy S8 file (8,013,982 bytes):

```text
dirPos = 8,013,926   "SEFH", version 103, 3 entries
  entry 0  type 0x0a01  negOffset 4,647,753  size 35        Image_UTC_Data
  entry 1  type 0x0aa1  negOffset 4,647,718  size 19        MCC_Data
  entry 2  type 0x0a30  negOffset 4,647,699  size 4,647,699 MotionPhoto_Data
contentLen = 48  "SEFT" at 8,013,978
```

The blocks are contiguous and the last one ends where the directory begins, so
entry 2's block spans `[dirPos - size, dirPos)`. Its payload — the video — starts
after the 8-byte block header and the 16-byte name, at 3,366,251, and is
4,647,675 bytes long. Both numbers were confirmed independently before this
parser saw the file, and the extraction is byte-identical to that range.

Two details that matter in practice:

* **The block header is usually outside every window.** For an inline video the
  block header sits megabytes before the trailer. The type (`0x0a30`) already
  identifies the block, and Samsung always uses the same name, so the name length
  falls back to a constant and the name is reported from the type. Nothing else
  about the trailer needs those bytes.
* **Newer devices store a pointer instead of the media.** A Galaxy S22 writes a
  12-byte `mpv2` record as the block payload: `"mpv2"`, then the video's absolute
  offset and size as big-endian `u32`s. The parser follows it.

### 3. `mpvd` box (ISOBMFF stills)

Motion Photo format 1.0 requires an ISOBMFF still (HEIC or AVIF) that carries a
motion photo to end with a top-level `mpvd` box whose payload is the whole video,
and to place no bytes after it. The box is found by scanning the windows for the
type and validating the header, so no item table is needed.

Samsung's HEICs use the same box but put `[MP4][sefd]` inside it, where the
`sefd` holds a SEFT trailer with an `mpv2` record; the record is preferred, and a
trailing `sefd` box is trimmed when the payload's own box chain can be walked.

### 4. HEIF video item

Some ISOBMFF files describe the video as an *item*: `iinf`/`infe` for the item
table, `iloc` for its extents, `pitm` for the primary image, and `iref` for the
`cdsc` reference that ties them together (`src/heif.rs`).

The trap here is worth stating plainly, because it makes **every ordinary HEIC
look like a motion photo**: `hvc1`, `hev1`, `av01`, `vp08` and `vp09` are the
*image* codecs of HEIC and AVIF, so the tiles of a normal phone photo carry
exactly the item types a naive "is this a video codec" test accepts. The rule
used here is therefore:

* a `mime` item whose `content_type` starts with `video/`, or
* a codec that can never be a HEIF still image (`avc1`, `avc3`, `mp4v`, `encv`),
* **and** the item is not one the primary `grid` references with `dimg`, which
  by definition makes it a picture,
* **and** it is not the primary item itself.

The `cdsc` reference and the item size only decide between candidates that are
already videos; they never promote an image. A plain HEIC — grid, tiles, Exif,
XMP, nothing else — therefore reports `motion: null`, which is asserted in both
the Rust unit tests and the end-to-end suite.

### 5. XMP (JPEG, and ISOBMFF as a fallback)

The head window is scanned for the properties below (`src/xmp.rs`). The scanner
accepts the RDF attribute form (`Camera:MotionPhoto="1"`), the element form, the
legacy `GCamera:`/`GContainerItem:` prefixes AOSP also accepts, and any namespace
prefix, and it requires a token boundary so `MotionPhotoVersion` cannot satisfy
`MotionPhoto`.

| Property | Use |
| --- | --- |
| `Camera:MotionPhoto`, `Camera:MotionPhotoVersion` | marks a Motion Photo 1.0 file |
| `Camera:MotionPhotoPresentationTimestampUs` | where the still sits inside the clip |
| `Container:Directory` → items with `Item:Mime`, `Item:Semantic`, `Item:Length`, `Item:Padding` | exact item lengths |
| `GCamera:MicroVideoOffset` | length of the trailing video (pre-1.0 Pixels) |

The directory lists items in file order. The primary image is first; the rest are
stored at the end of the file, so they are placed by walking backwards from
`file_size` and accumulating `Length + Padding`. The video is chosen by
`Item:Semantic="MotionPhoto"` with a video MIME type — never by position — so an
Ultra HDR `GainMap` item, which the specification requires to come *before* the
video item, is skipped correctly.

For an ISOBMFF still, an XMP length is only believed when the bytes it names
actually begin a media box. Real files exist whose XMP disagrees wildly with
reality: on one Galaxy S22 Ultra sample the primary item claims
`Item:Length="104"` for a 2,341,602-byte video.

### 6. Appended container

`find_appended_container()` looks for a second `ftyp` in any window and accepts
it only if a complete box chain can be walked from it to the end of the file
containing both a `moov` and an `mdat`, landing exactly on EOF. The plan is then
a single `File.slice()`. This is how a motion photo with no metadata at all is
still extracted verbatim.

### 7. Sample table

When the container start is not visible — a multi-megabyte video with `moov` at
the end of a file whose `ftyp` is beyond both windows — the core reads the sample
table instead (`src/mp4.rs`, `plan_from_moov`):

1. Find `moov` candidates by scanning the windows for the four-character code,
   requiring an explicit plausible size (a declared size of `0` would let
   zero-filled junk masquerade as a `moov`).
2. Parse `mvhd`, then per `trak`: `tkhd` (id, display size), `mdhd` (timescale,
   duration), `hdlr` (must be `vide`), `stbl` → `stsd` (codec fourcc, and the
   `avcC`/`hvcC` record used to build an RFC 6381 codec string), `stsz` (sample
   sizes), `stsc` (samples per chunk) and `stco`/`co64` (chunk offsets). A visual
   sample entry has 78 bytes of fixed fields before its child boxes, so a naive
   `boxes()` walk from the entry start reads those fields as a box header.
3. Compute each chunk's byte length and the media span `[first_chunk,
   last_chunk_end)`. Copying that whole span verbatim preserves every chunk's
   relative position even when chunks are not contiguous.
4. Emit `[synthesized ftyp][moov, chunk offsets patched][mdat header][verbatim
   span]`, shifting every `stco`/`co64` entry by `delta = (ftyp_len + moov_len +
   mdat_header_len) - span_start`. Overflow, fragmentation (`moof`/`mvex`) and
   implausible spans are refused with a reason rather than guessed at.

One caveat this route cannot fix on its own: the MP4 that a Samsung camera
appends has chunk offsets relative to its own start, not absolute file offsets as
the specification requires. That is exactly why the SEFT route is tried first —
it yields the true range, and the range is validated as a complete MP4 before it
is used, so the rebuild never has to guess a base.

## The plan

`probe()` returns JSON; the shape below is what the app consumes. `parts` is the
whole contract: literals are headers the core synthesized, slices are absolute
ranges of the **original** file.

```json
{
  "kind": "motion",
  "container": "jpeg",
  "fileSize": 3327,
  "still": { "mime": "image/jpeg", "width": 4032, "height": 3024,
             "length": 2080, "thumb": { "off": 1024, "len": 4096 } },
  "motion": { "found": true, "family": "samsung", "method": "appended-container",
              "confidence": "medium", "video": { "off": 2080, "len": 1247 },
              "timestampUs": 1250000, "playable": true,
              "codec": "avc1.42E01E", "width": 1080, "height": 1920,
              "durationMs": 768, "reason": null },
  "plan": { "mime": "video/mp4", "direct": true,
            "parts": [ { "t": "slice", "off": 2080, "len": 1247 } ] },
  "readMore": { "target": "window", "off": 4096, "bytes": 799,
                "regionOff": 4096, "regionLen": 799, "reason": "read the video header" },
  "meta": { "make": "Samsung", "model": "SM-G998B", "takenAt": "2023:05:04 11:22:33" },
  "markers": ["MotionPhoto_Data", "Camera:MotionPhoto"],
  "boxes": ["ftyp", "meta", "mdat"],
  "notes": ["video item #2 type=hvc1 name=MotionPhoto"]
}
```

A scan is two stages. Stage 1 sees the head and the tail, so it knows the
container, the metadata and which route found the video; stage 2 reads a window
at that range, so it knows the plan. `mergeStages()` in `src/wasm.js` joins them,
and takes care that stage 2's generic labels never overwrite the specific route
stage 1 identified.

`readMore` is the only way the core asks for more bytes. `target: "head"` and
`"tail"` grow that window and re-probe; `target: "window"` is a request to read
at `off` and call `mp_prepare` with `region` — that is how a video range found in
the metadata is turned into a plan when its header is outside both windows. The
driver stops as soon as a target would not grow (which is what makes the loop
provably terminating) or the budget runs out.

Codec strings are built to RFC 6381 because browsers parse them: for HEVC the
compatibility flags appear with their bits **reversed** (a Main-profile file
stores `0x60000000` and the string says `6`), trailing zero constraint bytes are
dropped, and the profile space becomes a leading letter. Printing the set bit
indices instead - the obvious misreading, and the bug this code shipped first -
yields `hvc1.1.30.29.L120.000000000000`, which no browser recognises, so a
perfectly playable clip is reported as unsupported before it is even attempted.
AVC needs no such care: `avc1.` plus profile, compatibility and level as hex.

`family` is a label, not a promise: `samsung` when `MotionPhoto_Data` appears in
the bytes or a trailer was found, `google` for the Motion Photo 1.0 properties,
`heif-item` for a `cdsc`-linked item, `unknown` when only structure gave it away.

## WebAssembly ABI

No wasm-bindgen, no imports, five exports:

```
mp_alloc(len) -> ptr            mp_free(ptr, len)
mp_probe(head, head_len, tail, tail_len, file_size) -> ptr
mp_prepare(region_off, region_len, w1, w1_len, w1_off, w2, w2_len, w2_off, file_size) -> ptr
mp_free_result(ptr)
```

Results are a little-endian `u32` length followed by UTF-8 JSON. Offsets and
sizes cross as `f64`, which is exact below 2^53 and avoids `BigInt` marshalling.
`src/wasm.js` is the entire marshalling layer.

## Verified, and not

Verified by `make verify`, `make verify-browser` and `make check-real` (41
deterministic checks, a headless browser run, and three genuine camera files):

* **Real hardware.** A Galaxy S8 JPEG, a 2020 Samsung HEIC and a Galaxy S22
  Ultra HEIC are resolved to the exact byte ranges recovered independently by
  hand, with ExifTool and with ffprobe: 4,647,675 B at offset 3,366,251;
  3,005,799 B; and 2,341,602 B. All three take the SEFT route, need no rebuild,
  and their extractions are byte-identical slices that ffprobe reads back with
  the same codec, width and height as the original range. Between 4% and 12% of
  each file is read. A Galaxy M34 5G file (7,061,733 B, 4,270,333 B of video at
  offset 2,791,277, HEVC Main level 4.0 with AAC) checks out the same way, with
  `--local` on the same script.
* **Classification.** A plain HEIC with HEVC image tiles is never reported as a
  motion photo; ordinary stills carry no play affordance, not even on hover; a
  still and a clip that merely share a name prefix are not paired, because only
  an exact stem pairs.
* **Orientation.** A landscape picture tagged `Orientation=6` is drawn portrait
  both from the full still and from an embedded IFD1 preview that has no tag of
  its own, and the viewer agrees with the tile. The exact drawn geometry is
  recorded by the renderer and asserted, rather than inferred from pixels.
* **Byte-exact extraction** for the SEFT JPEG (inline video and `mpv2` record),
  the `mpvd` HEIC, the two Samsung HEIC layouts, the item-based HEIC, the Google
  Motion Photo 1.0 JPEG, and the older `MicroVideoOffset` shape — each compared
  against the original MP4 bytes, not just parsed.
* **Rebuild correctness** where a slice is impossible: the sample bytes survive
  the rebuild verbatim, and ffprobe reads the rebuilt file as a valid MP4 with a
  video stream.
* **Bounded reading**: a 4 MB photo with a trailer `moov` is resolved without
  reading it all; a folder scan reads well under the folder size.
* **Hostile input**: random noise, empty files, truncated headers, absurd box
  sizes, a 1 MB zero-filled file, a bogus SEFT `contentLen`, and XMP claiming a
  50 MB video all return a decision with no plan out of bounds — and never trap,
  because the tests call the module directly.
* **In the browser**: motion photos detected, thumbnails decoded, the extracted
  video really decodes and advances, and **no request leaves the origin**.

Not verified, and worth stating plainly:

* **No Google Pixel and no Apple Live Photo sample** has been through this code.
  The Pixel JPEG path is covered by the specification, by AOSP's detector and by
  Media3's parser, and by synthetic files in the spec's shape; Apple pairing is by
  file name only.
* **The provenance of every real sample is a third-party public test corpus**,
  and one of them carries `PhotoEditor_Re_Edit_Data`, so it may have been
  rewritten by Samsung's editor. Detection does not depend on its XMP for exactly
  that reason.
* Fragmented MP4, multi-extent HEIF items, and QuickTime content-identifier
  pairing for Live Photos are **not** implemented; they are detected and
  reported, not guessed at.
* Whether an *older* revision of the specification described the video as a
  `cdsc`-linked item could not be confirmed — the archived revisions were
  unreachable. The item route is implemented anyway, and costs nothing.

If you have a file that behaves differently from the report above, the
inspector's **Copy report** button produces everything needed to add it as a
fixture, and `tests/fixtures/generated/` is where real media belongs.

The raw research log behind these routes — including the byte dumps, the source
citations and the author's own confidence markers — is kept at
[`docs/research/samsung-motion-photo-findings.md`](research/samsung-motion-photo-findings.md).
