> **Status:** raw research log, kept as evidence for the format decisions in
> this repository. The normative description of what the code does — and of what
> has actually been verified — is [`docs/FORMATS.md`](../FORMATS.md); where the two
> disagree, that document wins. Confidence markers below are the original
> author's: **[V]** verified against real file bytes or by running a tool,
> **[S]** verified in primary source code or specification text, **[U]**
> unverified.

# Motion Photo container formats — byte-level report (WASM viewer oriented)

Method: primary sources only — format specs, ExifTool source, AOSP/AndroidX, AndroidX Media3 extractors,
working extractor/muxer code — plus **empirical byte-level analysis of three real camera files**
(`g0ddest/sm_motion_photo` test data) and local ExifTool 13.59 + ffprobe 6.1 verification.

Real samples used (all in <https://github.com/g0ddest/sm_motion_photo/tree/master/tests/data>):

| file | size | origin (verified) | embedded video |
|---|---|---|---|
| `photo.jpg` | 8,013,982 | Samsung JPEG, `Make=samsung`, `Model=SM-G950U` (Galaxy S8), 2020-04-30 | H.264 High 1440x1080 15fps, 4,647,675 B |
| `photo.heic` | 5,755,343 | Samsung HEIC 2020-10-27 | HEVC Main 1440x1080 + AAC, 3,005,799 B |
| `photo-sg22-ultra.heic` | 2,849,914 | Samsung S22 Ultra, 2023-03-28, has `PhotoEditor_Re_Edit_Data` in trailer | HEVC Main L120 + AAC, 2,341,602 B |

Legend for confidence: **[V]** = verified against real file bytes and/or executed locally; **[S]** = verified
in primary source code/spec text; **[U]** = unverified / inferred.

---

## 1. Samsung JPEG motion photos (Galaxy S7–S10 era)

**Where the MP4 is.** Appended **after the JPEG EOI**, as the payload of a trailer block. It is *not* in an
APP segment. In `photo.jpg`: JPEG data ends, `FFD9` is followed by the trailer; the MP4's `ftyp` box-size
field starts exactly 16 bytes after the ASCII block name (see below). **[V]**

**Trailer detection signature.** The trailer is a backwards-linked structure ending the file. ExifTool
requires the last 6 bytes to be `"QDIOBS"` **or** `"\x00\x00SEFT"` (`Samsung.pm`, `ProcessSamsung`). **[S]**
Real file: last 6 bytes = `00 00 53 45 46 54` (`\0\0SEFT`), i.e. the last 4 bytes are the ASCII `SEFT`. **[V]**

**Exact layout (all little-endian unless noted).**

```
FILE = [JPEG … EOI] [ SEFT trailer ]                        <- trailer, no length field anywhere else
SEFT trailer =  block_0 | block_1 | … | block_n | SEFH_dir | footer
footer       =  uint32LE contentLen | "SEFT"                (4 + 4 bytes, ends the file)
SEFH_dir     =  "SEFH" | uint32LE version | uint32LE count | count × entry(12 bytes)
entry(12)    =  uint16 0x0000 | uint16LE type | uint32LE negOffset | uint32LE size
block        =  uint16 0x0000 | uint16LE type | uint32LE nameLen | name[nameLen] | payload
block file position = dirPos − negOffset      where dirPos = file offset of the "SEFH" 'S'
size         = 8 + nameLen + payloadLen       (block total, payload runs to end of block)
```

`photo.jpg` ground truth: `dirPos = 8013926`, `contentLen = 48`, `version = 103`, `count = 3`; **[V]**
entries: `0x0a01 "Image_UTC_Data"`, `0x0aa1 "MCC_Data"`, `0x0a30 "MotionPhoto_Data"`; the `0x0a30` block is
`blockStart = 3366227`, `nameLen = 16`, `size = 4647699`, payload `= [3366251, 8013926)` = 4,647,675 B =
`"MotionPhoto_Data"` offset **+16** … **SEFH offset**. **[V]**

**Finding the video without scanning.** Yes — read the last 8 bytes (`[contentLen]"SEFT"`), seek back to
`dirPos`, read the directory, pick entry `type == 0x0a30`, then read 8 bytes at `dirPos − negOffset` to get
`nameLen`, then the payload. Two reads from the end plus one block header. **[V]**

**Device-generation split.** Older devices inline the MP4 in the block payload → `Samsung:EmbeddedVideoFile`
(`photo.jpg`, `photo.heic`). Newer Samsung writes a 12-byte payload instead:
`"mpv2" | uint32**BE** absoluteFileOffset | uint32**BE** videoSize` → ExifTool calls this
`Samsung:EmbeddedVideoOffsetSize`. Verified on the S22 file: payload bytes
`6d 70 76 32 | 00 07 bf b3 | 00 23 ba e2` → 507827 / 2341602, and `[507827, 2849429)` is exactly the video
(ends where the trailing `sefd` box begins). **[V]** (ExifTool source: `'0x0a30' => [{ Name =>
'EmbeddedVideoOffsetSize', Condition => 'length $$valPt == 12', ValueConv => 'join(" ", unpack("x4N2", $val))' }, …]` **[S]**)

**"EmbeddedVideoFile" / "STMN" / "SAMSUNG" claim.** `EmbeddedVideoFile` **never appears in file bytes** — it
is an ExifTool *tag name* (`grep` for it in `photo.jpg`/`photo.heic`: not found). `MotionPhoto_Data`
**does** appear (block name). `STMN` is unrelated: it is the header of Samsung **EXIF maker notes**
(`Image::ExifTool::Samsung::Main`, "binary STMN format maker notes"), nothing to do with the video trailer —
`STMN` does not occur anywhere in `photo.jpg`. `SAMSUNG` in caps does not occur either (the model is in EXIF
`Make = "samsung"`). **[V]** `"QDIO"`/`"QDIOBS"` is a *different* SEFT block pair used by "Sound & Shot"
audio. **[S]**

**What `Samsung:EmbeddedVideoFile` is.** A **trailer-derived** tag, not a maker note: group `Samsung`, family-0
group `MakerNotes`, family-2 group `Video`, declared inside the `Image::ExifTool::Samsung::Trailer` table
(`PROCESS_PROC => \&ProcessSamsung`, `GROUPS => { 0 => 'MakerNotes', 2 => 'Video' }`, `TAG_PREFIX =>
'SamsungTrailer'`). It refers to the *payload* of the `0x0a30` block, so its byte length is
`size − 8 − nameLen`, i.e. **exactly the MP4**. **[S][V]**

**Is `exiftool -b -Samsung:EmbeddedVideoFile f.jpg > out.mp4` a real idiom?** Yes. `-b` / `--b` /
`-binary` is documented as "Output requested metadata in binary format … mainly used for extracting
embedded images or other binary data"; the canonical Samsung recipe is
`exiftool -EmbeddedVideoFile -b -w _MotionPhoto.mp4 *.jpg` from the PhotoPrism issue. `-w` replaces the
source extension. I verified end-to-end that ExifTool's extraction of a trailer-derived video is
byte-exact (synthetic Google file, `cmp` match) and that its Samsung JPEG output length equals my
independent parse. **[S][V]**

Gotcha: a naive `tail -c` / "split at MotionPhoto_Data" extractor (e.g. the widely copied shell/Python
scripts) yields the MP4 **plus** the remaining SEFT trailer bytes; ffmpeg/browsers usually tolerate the
trailing bytes, but the exact end is the `SEFH` offset. **[V]**

---

## 2. Samsung HEIC motion photos

The video is **not** a HEIF item, **not** a second appended MP4 (there is exactly **one** `ftyp` in each
file), and **not** a `moov` track of the image file. It is a **top-level sibling box after the image boxes**.
**[V]**

`photo.heic` (2020) top-level boxes: `ftyp` | `mdat` | `meta` | **`sefd`** — the `sefd` box (size 3,005,941)
runs to EOF and *contains the SEFT trailer*, with the MP4 inline as the `MotionPhoto_Data` payload.
**[V]** ExifTool routes it via `sefd => { Name => 'SamsungTrailer', SubDirectory => { TagTable =>
'Image::ExifTool::Samsung::Trailer' } }`. **[S]**

`photo-sg22-ultra.heic` top-level boxes: `ftyp` | `mdat` | `meta` | **`mpvd`** (size 2,342,095, to EOF), where
`mpvd` payload = `[complete MP4][sefd box (485 B) containing the SEFT trailer]`; the trailer's
`MotionPhoto_Data` block holds the 12-byte `mpv2` offset/size record instead of the video. **[V]** The
third-party muxer `PetrVys/MotionPhoto2` builds exactly this (`video_footer()`: `mpvd_header + video_bytes +
[BE len]"sefd" + tag_data + sefh`), and its `SAMSUNG_SEFH_VERSION = 107` matches the real S22 file. **[S]**

`meta`/item types in both real Samsung HEICs: `infe v2` item types are `hvc1` (tiles), `grid` (primary,
`pitm` = 49), `Exif`, and in the S22 also `mime` with `content_type = "application/rdf+xml"` (the XMP item).
**All `item_name` strings are empty (`""`)** — there is no well-known item name string. **[V]** A
"`MotionPhoto`" *item name* does not exist in these files; `MotionPhoto` in Samsung files is a **block name**
(`MotionPhoto_Data`) or an XMP `Item:Semantic` value.

**`cdsc` in Samsung HEICs is a red herring.** Both files contain `cdsc` boxes in `iref`, but they are
`cdsc 51 → [1,49]` (the **Exif** item describing image items) and, on the S22, also `cdsc 52 → [1,49]`
(the **XMP** item). No video item exists, so **no `cdsc` from a video item to the primary is used by
Samsung**. **[V]**

---

## 3. Google / Android Motion Photo 1.0 (JPEG variant)

**Namespaces/prefixes** (spec + AOSP literals) **[S]**:

| prefix | namespace URI | notes |
|---|---|---|
| `Camera` | `http://ns.google.com/photos/1.0/camera/` | spec default |
| `GCamera` | same URI | legacy prefix — same properties |
| `Container` | `http://ns.google.com/photos/1.0/container/` | `Container:Directory` |
| `GContainer` | same URI | legacy prefix |
| `Item` | `http://ns.google.com/photos/1.0/container/item/` | `Item:Mime`, `Item:Semantic`, `Item:Length`, `Item:Padding` |
| `GContainerItem` | same URI | legacy prefix (**note:** prefix is `GContainerItem`, *not* `GContainer:Item`) |

Properties: `Camera:MotionPhoto` (Integer, 1 = motion photo; 0/negative = never), `Camera:MotionPhotoVersion`
(=1), `Camera:MotionPhotoPresentationTimestampUs` (Long, −1 = unset/unannotated).
MicroVideo V1b legacy (deleted in 1.0 but still emitted by tools): `Camera:MicroVideo`,
`Camera:MicroVideoVersion`, `Camera:MicroVideoOffset`, `Camera:MicroVideoPresentationTimestampUs`.
AOSP's literal list: `"Camera:MotionPhoto"`, `"GCamera:MotionPhoto"`, `"Camera:MicroVideo"`,
`"GCamera:MicroVideo"` and semantics `"Primary"`, `"MotionPhoto"`. **[S]**

**Packet.** Standard XMP in a **JPEG APP1 segment** with the standard header
`"http://ns.adobe.com/xap/1.0/"` + NUL (Media3 `HEADER_XMP_APP1`, read with `readNullTerminatedString`).
**[S]** Verified: a synthetic file with such an APP1 is detected by ExifTool as a Google trailer. **[V]**

**Byte range.** Not stored as an absolute offset: it is derived from `Item:Length` counted **backwards from
EOF**. Media3 `MotionPhotoDescription.getMotionPhotoMetadata(fileLength)` walks items from last to first:
`itemStart = fileLength − Σ(lengths of later items) − item.length`, and for the primary item it additionally
subtracts `Item:Padding`. For `[Primary(image/jpeg, len 0, pad P), MotionPhoto(video/mp4, len L, pad 0)]`
the video is simply **`[fileLength − L, fileLength)`**. Legacy `MicroVideoOffset` is treated as
`length = microVideoOffset` from the same end-anchored logic. **[S]** Verified: ExifTool extracted the
appended MP4 from my synthetic file byte-exactly (`cmp` 0), and with `Item:Padding="64"` it still found the
video (it scans forward for the MP4 signature when the first bytes don't match). **[V]**

ExifTool's fallback scan regex is narrow — `\0\0\0.ftyp(mp42|isom)` — i.e. it only recognizes major brands
`mp42`/`isom` and box sizes < 16 MiB. A parser should not copy that restriction. **[S]**

---

## 4. ISO-BMFF / HEIC Motion Photo 1.0 (Android 12+/Pixel spec)

**Spec wording (Motion Photo 1.0, "ISOBMFF-image-specific behavior"):** motion photos with ISOBMFF-based
images "must have a structure such that the image portion of the file terminates with a top-level
'Motion Photo Video Data' box":

```
// Box as defined in ISO/IEC 14496-12:2015: 4.2
aligned(8) class MotionPhotoVideoData extends Box('mpvd') {
  bit(8) data[];
}
```

"where the `data` field contains **all of the video bytes**", size `0` is not allowed, and the XMP
`Item:Padding` of the primary item **must equal 8** (the `mpvd` header size: 4-byte size + 4-byte type). The
XMP directory must be `Primary` (`image/heic`/`image/avif`) + `MotionPhoto` (`video/mp4` or
`video/quicktime`), with the video item last: "The location of this media item must be at the end of the
file. No other bytes may be placed after this media item's bytes have terminated." **[S]**

**No item reference is involved.** The spec defines no `cdsc` (or any `iref`) link from a video item; the
video is a **box**, not an item. `iinf`/`iloc` are used only for the *still image's* items — Media3 uses
`iinf` (`infe` with `item_type == 'mime'` and `content_type == "application/rdf+xml"`) plus `iloc`
(`base_offset + extent_offset`, `extent_length`) purely to locate the XMP packet, and `pitm` identifies the
primary image item. **[S]** Real Android-spec Samsung file confirms this (see §2): `pitm = 49`, XMP item 52
`mime`/`application/rdf+xml` at `iloc` extent `(503707, 1280)`, and the video in the `mpvd` box. **[V]**

**Is the video item self-contained?** Yes for the `mpvd` payload: Media3's `HeicMotionPhotoExtractor` sets
`videoStartPosition = input position immediately after the mpvd box header` and `videoSize = atomSize −
mpvdHeaderSize`, then hands that exact range to a plain `Mp4Extractor` (`sniff` + `read`). **[S]** I
reproduced this by slicing the real files and confirming `ffprobe` parses them and `ffmpeg -f null -`
decodes them completely (both streams, exit 0). **[V]**

**Practical warning on Samsung HEIC + XMP.** In `photo-sg22-ultra.heic` the XMP is present and says
`Item:Length="104"` / `Item:Padding="67"`, while the real video is 2,341,602 bytes at `[507827, 2849429)`.
Anyone computing the range from XMP on that file gets `[2849810, 2849914)` — inside the trailer. This is why
Media3's HEIC extractor takes only `MotionPhotoPresentationTimestampUs` from XMP and locates the video from
the `mpvd` box. For Samsung HEIC, prefer: (a) the `mpv2` record (`EmbeddedVideoOffsetSize`), else (b) the
`mpvd` box payload minus a trailing `sefd` box if present, else (c) the SEFT `0x0a30` block size. **[V]**

---

## 5. Apple Live Photo HEIC vs Android/Samsung HEIC motion photo

- Apple Live Photo is a **pair of files** (`.HEIC` + `.MOV`), not one file; the video is not embedded in the
  HEIC. Linking is by UUID: ExifTool `Apple:ContentIdentifier` (Apple maker note 0x0011, "if defined, there is
  a live photo associated with the video"), mirrored in the MOV as `com.apple.quicktime.content.identifier`,
  plus `still-image-time` metadata in the MOV (`StillImageTime`, value always −1) and
  `Apple:LivePhotoVideoIndex` (0x0017). **[S]**
- An Android/Samsung HEIC motion photo instead contains `mpvd` (or `sefd`) and `Camera/GCamera:MotionPhoto=1`
  XMP; it has no Apple maker-note `ContentIdentifier`. **[S][V]**
- **[U]** I did not obtain an Apple Live Photo HEIC sample, so the Apple side is source-verified only, not
  byte-verified. Apple HEICs also carry `apple-fi:`/`HDRGainMap` XMP namespaces (see `MotionPhoto2`'s XMP
  template), so don't use "has XMP" as a discriminator.

---

## 6. Answering the literal questions

**(a) Does "EmbeddedVideoFile" or "MotionPhoto_Data" appear in the bytes?** `EmbeddedVideoFile`: **no** — it
is an ExifTool tag name only. `MotionPhoto_Data`: **yes** — a 16-byte ASCII block name inside the SEFT
trailer (type `0x0a30`), present in the Samsung JPEG, the 2020 HEIC `sefd` box, and the S22 trailer. **[V]**
"EmbeddedVideoType = MotionPhoto_Data" in ExifTool is the *name* of that block (tag `0x0a30-name`). **[S]**

**(b) Samsung HEIC storage.** Not a HEIF item, not a second `ftyp`/`moov`: a top-level `sefd` box (2020) or
a top-level `mpvd` box (S22, Android-spec) — both after all image boxes. Item types seen: `hvc1`, `grid`,
`Exif`, `mime`; **item names are empty**. **[V]**

**(c) Google ISOBMFF structure.** Image boxes, then top-level `mpvd` whose `data[]` is the complete video;
XMP `Container:Directory` = `Primary` + `MotionPhoto` (last item, `Item:Padding` = 8 on primary); **no item
reference**; the video byte range is a standalone playable MP4. **[S][V]**

**(d) `-b`.** Only meaning found in this space: ExifTool's `-b` / `-binary` flag. **No** `-b` file-name
suffix, container field, or magic string exists in any of the ~12 extractor/muxer implementations, the two
specs, AOSP code, or the three real camera files I inspected. Real vendor filename conventions are the
spec's `…MP.jpg`/`…MP.HEIC` regex and Google Camera's `MVIMG_*.jpg` (pre-7.5) / `PXL_*.MP.jpg`. **[S][V]**

**(e) GainMap.** The spec requires a motion photo with an Ultra HDR primary to include a third item with
`Item:Semantic="GainMap"`, and **writers must place the gainmap item element before the video item
element**. So a parser must select by `Item:Semantic == "MotionPhoto"` (and MIME `video/*`) and **never by
position** ("the second item") — and must ignore `GainMap` items when summing lengths, since padding/length
arithmetic walks every item after the video. **[S]**

---

## 7. Practical playback (Blob URL) per family

| | Samsung JPEG | Google JPEG (Pixel) | Samsung/Android HEIC (`mpvd`) |
|---|---|---|---|
| slice self-contained | **yes [V]** | **yes [V]**, by design (Media3) | **yes [V]** |
| `ftyp` at slice start | yes, `ftyp/mp42` 24 B **[V]** | yes (spec: video is a container file) **[S]** | yes, `ftyp/mp42` 24 B **[V]** |
| box order | `ftyp, mdat, moov` — **moov at END (not faststart)** **[V]** | device-dependent; Pixel files also non-faststart (moov last) — **[U]** for exact per-device order | `ftyp, mdat, moov` — **moov at END** **[V]** |
| codec | H.264 High 1440×1080 15 fps, no audio **[V]** | usually H.264; some Pixel files carry **HEVC** tracks (media3 test `pixel-motion-photo-2-hevc-tracks.jpg`) **[S]** | **HEVC Main** + AAC **[V]** |
| bytes to synthesize/patch | none **[V]** | none **[V]** | none for `[videoStart, videoEnd)`; do **not** slice `[mpvd payload, EOF)` — 485 trailing `sefd` bytes in the S22 file **[V]** |

Browser decode caveat: HEVC in `<video>` is **not** universally decodable — caniuse: Safari "y"; Chrome/Edge
"partial, hardware support required (macOS ≥ Big Sur, Android ≥ 5, Windows with HW support, etc.)"; Firefox
"partial, hardware support, software fallback in some cases" (<https://caniuse.com/hevc>). So Samsung HEIC
motion photos (and some Pixel files) may load metadata but fail to render on many desktops, whereas the
H.264 Samsung/Pixel JPEG videos play broadly. `moov`-at-end is harmless for a `Blob`/`blob:` URL (all bytes
are local and seekable) but is not suitable for progressive HTTP streaming without range support or for MSE.

---

## 8. Explicitly NOT verified

1. **No real Google Pixel file was obtained.** The media3 samples (`jpeg/pixel-motion-photo-*.jpg`,
   `heif/sample_MP.heic`) are not publicly downloadable at the URLs I could reach. The Google JPEG path is
   verified against the spec, AOSP `SpecialFormatDetector`, Media3's parser/extractor source, and a
   **synthetic** end-to-end file — but not against a Pixel original.
2. **No Apple Live Photo sample** (see §5) — Apple-specific claims are ExifTool-source-derived only.
3. Exact XMP `Item:Length` reliability across Samsung HEIC firmware versions: the single S22 sample is
   internally inconsistent (Length 104 vs 2,341,602 real bytes), and that file also shows
   `PhotoEditor_Re_Edit_Data`, so it may have been rewritten by Samsung's editor. Sampling more devices is
   needed before generalizing.
4. Whether every Android 12/13-era HEIC motion photo uses `mpvd` (vs. an earlier item/`cdsc`-based draft):
   **I could not retrieve the pre-2024 revision of the spec** (exiftool.org forum and web.archive.org were
   both down during this research), so I cannot exclude that an older draft used `cdsc`. Every real
   Samsung file and all current Google code I inspected uses `mpvd`/`sefd`, with `cdsc` belonging to
   Exif/XMP items.
5. Segment-level JPEG statement "appended after EOI": true for the real Samsung file (EOI then trailer) and
   consistent with the spec/ExifTool/Media3 for the Google case; my synthetic Pixel-style file placed the
   video after EOI and worked, but no real Pixel byte layout was inspected.

## Sources

- Motion Photo format 1.0 — <https://developer.android.com/media/platform/motion-photo-format>
- ExifTool `Samsung.pm` (SEFT trailer parser, tag table) — <https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Samsung.pm>
- ExifTool `QuickTime.pm` (`sefd`, `mpvd`, `cdsc`, Apple Keys) — <https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTime.pm>
- ExifTool `Trailer.pm` (`Trailer::Google`, `MotionPhotoVideo`) — <https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Trailer.pm>
- ExifTool `JPEG.pm` (trailer routing) and `Apple.pm` (`ContentIdentifier`) — same repo
- ExifTool `-b`/`-w` documentation — <https://exiftool.org/exiftool_pod.html>
- PhotoPrism issue #439 (canonical extraction recipe, `EmbeddedVideoType: MotionPhoto_Data`) — <https://github.com/photoprism/photoprism/issues/439>
- AOSP MediaProvider `SpecialFormatDetector.java` — <https://github.com/aosp-mirror/platform_packages_providers_mediaprovider/blob/main/src/com/android/providers/media/util/SpecialFormatDetector.java>
- Media3 `XmpMotionPhotoDescriptionParser.java`, `MotionPhotoDescription.java`, `JpegMotionPhotoExtractor.java`, `HeicMotionPhotoExtractor.java` — <https://github.com/androidx/media/tree/release/libraries/extractor/src/main/java/androidx/media3/extractor>
- Real samples — <https://github.com/g0ddest/sm_motion_photo/tree/master/tests/data> (Rust extractor `src/lib.rs` uses `MotionPhoto_Data` + 16)
- Samsung muxer reference implementation (`constants.py`, `SamsungTags.py`) — <https://github.com/PetrVys/MotionPhoto2>
- Apple→Google converter (MicroVideoOffset = video length) — <https://github.com/aviv926/MotionPhotoMuxer-HEIC>
- HEVC browser support — <https://caniuse.com/hevc>
