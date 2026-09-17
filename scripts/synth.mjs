/**
 * Pure-JavaScript fixture builders.
 *
 * These produce structurally real files — a JPEG shell, a genuine ISO-BMFF
 * `moov`/`mdat` pair, a Google Motion Photo 1.0 XMP packet, a HEIC with a video
 * item — so the verification suite always has something meaningful to parse,
 * even on a machine without ffmpeg. `make-fixtures.mjs` adds *genuinely encoded*
 * media on top of this for the byte-exact and ffprobe checks.
 */

const BE = (n, bytes) => {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
};

export const u16 = (n) => BE(n, 2);
export const u32 = (n) => BE(n, 4);
export const u64 = (n) => BE(n, 8);
export const u16le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
export const u32le = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

export function fourcc(text) {
  if (text.length !== 4) throw new Error(`fourcc must be 4 chars: ${text}`);
  return new TextEncoder().encode(text);
}

export function concat(parts) {
  const list = parts.filter(Boolean).map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const total = list.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of list) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `size` + `type` + body. */
export function box(type, ...body) {
  const payload = concat(body);
  return concat([u32(payload.length + 8), fourcc(type), payload]);
}

export function ftyp(major = 'isom', compatible = ['isom', 'mp41']) {
  return box('ftyp', fourcc(major), u32(0), ...compatible.map(fourcc));
}

export function mdatHeader(payloadLen) {
  return concat([u32(payloadLen + 8), fourcc('mdat')]);
}

/**
 * A parseable `moov` with one video trak holding a single chunk of `chunkLen`
 * bytes at absolute file offset `chunkOffset`.
 */
export function moov({ chunkOffset, chunkLen, width = 1080, height = 1920, timescale = 1000, duration = 768 }) {
  const avcC = box('avcC', new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff]));
  const sampleEntry = concat([
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    new Uint8Array(16), // pre_defined / reserved
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    new Uint8Array(32),
    u16(0x0018),
    u16(0xffff),
    avcC,
  ]);
  const avc1 = concat([u32(sampleEntry.length + 8), fourcc('avc1'), sampleEntry]);
  const stsd = box('stsd', u32(0), u32(1), avc1);
  const stts = box('stts', u32(0), u32(1), u32(1), u32(duration));
  const stsc = box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1));
  const stsz = box('stsz', u32(0), u32(0), u32(1), u32(chunkLen));
  const stco = box('stco', u32(0), u32(1), u32(chunkOffset));
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const minf = box('minf', stbl);
  const mdhd = box('mdhd', u32(0), new Uint8Array(8), u32(timescale), u32(duration), new Uint8Array(4));
  const hdlr = box('hdlr', u32(0), u32(0), fourcc('vide'), new Uint8Array(12));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = box(
    'tkhd',
    u32(7),
    new Uint8Array(8),
    u32(1),
    u32(0),
    u32(duration),
    new Uint8Array(8),
    new Uint8Array(8),
    new Uint8Array(36),
    u32(width * 65536),
    u32(height * 65536),
  );
  const trak = box('trak', tkhd, mdia);
  const mvhd = box('mvhd', u32(0), new Uint8Array(8), u32(timescale), u32(duration), new Uint8Array(80));
  return box('moov', mvhd, trak);
}

/**
 * A complete little MP4.
 * @param {{payload?: number, moovAtFront?: boolean, baseOffset?: number}} options
 */
export function mp4({ payload = 512, moovAtFront = true, baseOffset = 0 } = {}) {
  return buildMp4({ payload, moovAtFront, baseOffset }).bytes;
}

/**
 * The same MP4 plus the absolute offsets a test needs to reason about it.
 *
 * `baseOffset` is where the MP4 itself lands in the enclosing file: chunk
 * offsets inside `stco` are absolute file offsets in real files, so a fixture
 * that appends an MP4 to an image has to shift them.
 *
 * @returns {{bytes: Uint8Array, chunkOffset: number, payloadLength: number, moovLength: number}}
 */
export function buildMp4({ payload = 512, moovAtFront = true, baseOffset = 0 } = {}) {
  const payloadBytes = new Uint8Array(payload).fill(0xa5);
  const header = mdatHeader(payloadBytes.length);
  const head = ftyp();
  const moovLength = moov({ chunkOffset: 0, chunkLen: payloadBytes.length }).length;
  const chunkOffset = baseOffset + (moovAtFront
    ? head.length + moovLength + header.length
    : head.length + header.length);
  const moovBox = moov({ chunkOffset, chunkLen: payloadBytes.length });
  const bytes = moovAtFront
    ? concat([head, moovBox, header, payloadBytes])
    : concat([head, header, payloadBytes, moovBox]);
  return { bytes, chunkOffset, payloadLength: payloadBytes.length, moovLength };
}

/** A minimal but valid JPEG shell (SOI, APP0, SOS, entropy bytes, EOI). */
export function jpegShell(bytes = 1024) {
  return concat([
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe0, 0x00, 0x10]),
    new TextEncoder().encode('JFIF\0'),
    new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    new Uint8Array([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
    new Uint8Array(bytes).fill(0x33),
    new Uint8Array([0xff, 0xd9]),
  ]);
}

/** Wraps an XMP packet in the APP1 segment Google and Samsung write. */
export function xmpApp1(packet) {
  const ns = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
  const body = concat([ns, new TextEncoder().encode(packet)]);
  if (body.length + 2 > 0xffff) throw new Error('XMP packet too large for one APP1 segment');
  return concat([new Uint8Array([0xff, 0xe1]), u16(body.length + 2), body]);
}

/** The `Container:Directory` packet of Motion Photo format 1.0. */
export function googleMotionXmp({
  stillLen,
  videoLen,
  timestampUs = 1250000,
  stillMime = 'image/jpeg',
  gainMapLen = 0,
}) {
  const gainMap = gainMapLen
    ? `     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="${gainMapLen}" Item:Padding="0"/>
     </rdf:li>
`
    : '';
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    Camera:MotionPhoto="1"
    Camera:MotionPhotoVersion="1"
    Camera:MotionPhotoPresentationTimestampUs="${timestampUs}">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="${stillMime}" Item:Semantic="Primary" Item:Length="${stillLen}" Item:Padding="0"/>
     </rdf:li>
${gainMap}     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLen}" Item:Padding="0"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

/**
 * A Samsung-style file: JPEG with the MP4 appended verbatim and no XMP.
 *
 * `padAfterImage` inserts filler between the image and the video, which is how
 * a real multi-megabyte capture looks: the video's own headers then sit far
 * from both the head and the tail of the file.
 */
export function samsungMotionJpeg({ moovAtFront = false, payload = 700, padAfterImage = 0 } = {}) {
  const shell = jpegShell(2048);
  const padding = new Uint8Array(padAfterImage).fill(0x77);
  const videoStart = shell.length + padAfterImage;
  const video = buildMp4({ payload, moovAtFront, baseOffset: videoStart });
  return {
    file: concat([shell, padding, video.bytes]),
    video: video.bytes,
    imageLen: shell.length,
    paddingLength: padAfterImage,
    videoOffset: videoStart,
    payloadOffset: video.chunkOffset,
    payloadLength: video.payloadLength,
  };
}

/** A Google-style file: JPEG with XMP and the MP4 appended verbatim. */
export function googleMotionJpeg({ payload = 640, timestampUs = 1250000 } = {}) {
  // The still length is not known until the packet exists, and the packet's
  // `Item:Length` must match, so build it once with a placeholder shell to
  // learn the still length, then rebuild the video with absolute offsets.
  const shell = jpegShell(1500);
  const measure = concat([shell.slice(0, 2), xmpApp1(googleMotionXmp({ stillLen: 0, videoLen: 1024 })), shell.slice(2)]);
  const video = buildMp4({ payload, moovAtFront: true, baseOffset: measure.length });
  const packet = (stillLen) => googleMotionXmp({ stillLen, videoLen: video.bytes.length, timestampUs });
  const withXmp = (stillLen) =>
    concat([shell.slice(0, 2), xmpApp1(packet(stillLen)), shell.slice(2)]);
  // The XMP records the final still length, which the packet length affects, so
  // solve it with a fixed point (it converges in one step).
  let still = withXmp(0);
  still = withXmp(still.length);
  return {
    file: concat([still, video.bytes]),
    video: video.bytes,
    imageLen: still.length,
    videoOffset: still.length,
    payloadOffset: still.length + video.chunkOffset,
    payloadLength: video.payloadLength,
    timestampUs,
  };
}

/**
 * A HEIC whose `meta` box describes one video item, per Motion Photo format
 * 1.0: the primary image item is tied to the video item through `cdsc`.
 *
 * `buildItem` receives the item's true absolute file offset, because a real
 * writer stores absolute chunk offsets and the item's own length feeds back
 * into that offset. Lengths do not depend on the offset value, so one pass is
 * enough.
 */
export function heicWithItem(buildItem, { padTo = 0, primarySize = 3000 } = {}) {
  const primary = new Uint8Array(primarySize).fill(0x11);
  const ftypBox = ftyp('heic', ['heic', 'mif1']);

  const infe = (id, type, name, contentType) => {
    const parts = [u32(2 << 24), u16(id), u16(0), fourcc(type), new TextEncoder().encode(`${name}\0`)];
    // A video item is a `mime` item with a video content type; `hvc1` would be
    // an HEVC *image*, which is what a plain HEIC is full of.
    if (contentType) parts.push(new TextEncoder().encode(`${contentType}\0`));
    return box('infe', ...parts);
  };
  const iinf = box(
    'iinf',
    u32(0),
    u16(2),
    infe(1, 'hvc1', 'Primary'),
    infe(2, 'mime', 'MotionPhoto', 'video/mp4'),
  );
  const pitm = box('pitm', u32(0), u16(1));
  const iref = box('iref', u32(0), box('cdsc', u16(1), u16(1), u16(2)));
  const ispe = box('iprp', box('ipco', box('ispe', u32(0), u32(4032), u32(3024))));
  const metaFor = (videoOffset, videoLength) =>
    box(
      'meta',
      u32(0),
      pitm,
      iinf,
      box(
        'iloc',
        u32(0),
        new Uint8Array([0x44, 0x00]),
        u16(2),
        u16(1), u16(0), u16(1), u32(0), u32(primary.length),
        u16(2), u16(0), u16(1), u32(videoOffset), u32(videoLength),
      ),
      iref,
      ispe,
    );

  const probeLength = buildItem(0).length;
  // Layout is ftyp | meta | mdat[primary, item], so the item offset includes
  // the primary image bytes.
  const videoOffset = ftypBox.length + metaFor(0, probeLength).length + 8 + primary.length;
  const item = buildItem(videoOffset);
  const metaBox = metaFor(videoOffset, item.length);
  const base = concat([ftypBox, metaBox, box('mdat', primary, item)]);

  const result = {
    file: base,
    videoOffset,
    videoLength: item.length,
    item,
    primaryLength: primary.length,
  };
  if (padTo > base.length) {
    const padded = new Uint8Array(padTo);
    padded.set(base, 0);
    result.file = padded;
  }
  return result;
}

/** A small file that is not an image at all. */
export function textFile(text = 'this is not a picture') {
  return new TextEncoder().encode(text);
}

/** Deterministic pseudo-random bytes, for hostile-input tests. */
export function noise(len, seed = 1) {
  const out = new Uint8Array(len);
  let x = seed >>> 0;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

// ---------------------------------------------------------------- Samsung SEFT
//
// Real Galaxy files end with this trailer, and it sits *after* the video. The
// `MotionPhoto_Data` block either holds the MP4 inline or a 12-byte `mpv2`
// pointer record naming its absolute offset and size.

export function mpv2Record(offset, size) {
  return concat([new TextEncoder().encode('mpv2'), u32(offset), u32(size)]);
}

/**
 * Appends a SEFT trailer to `base`.
 * @param {Uint8Array} base
 * @param {{type: number, name: string, payload: Uint8Array}[]} blocks
 */
export function appendSeft(base, blocks) {
  const parts = [base];
  const positions = [];
  const payloads = [];
  let length = base.length;
  for (const block of blocks) {
    positions.push(length);
    const encoded = seftBlock(block.type, block.name, block.payload);
    payloads.push(length + 8 + new TextEncoder().encode(block.name).length);
    parts.push(encoded);
    length += encoded.length;
  }
  const dirPos = length;
  const dir = [new TextEncoder().encode('SEFH'), u32le(103), u32le(blocks.length)];
  blocks.forEach((block, index) => {
    const size = 8 + new TextEncoder().encode(block.name).length + block.payload.length;
    dir.push(u16le(0), u16le(block.type), u32le(dirPos - positions[index]), u32le(size));
  });
  const dirBytes = concat(dir);
  parts.push(dirBytes);
  // Verified against a real Galaxy S8 file: contentLen is the directory itself
  // (12-byte header plus 12 bytes per entry), and the footer follows it.
  parts.push(u32le(dirBytes.length), new TextEncoder().encode('SEFT'));
  return { file: concat(parts), blocks: positions, payloadOffsets: payloads };
}

function seftBlock(type, name, payload) {
  const nameBytes = new TextEncoder().encode(name);
  return concat([u16le(0), u16le(type), u32le(nameBytes.length), nameBytes, payload]);
}

/** Samsung JPEG: image, video, then a SEFT trailer naming the video. */
export function samsungSeftJpeg({ payload = 900, useMpv2 = false, video: supplied } = {}) {
  const shell = jpegShell(2048);
  // The video lives right after the image data, and the `MotionPhoto_Data`
  // block *is* that region: its header sits immediately before the video. In
  // the pointer variant the video is plain appended data and the block holds a
  // 12-byte record instead.
  const videoBytes = supplied ?? buildMp4({ payload, moovAtFront: false, baseOffset: shell.length }).bytes;
  const video = { bytes: videoBytes };
  const base = useMpv2 ? concat([shell, video.bytes]) : shell;
  const blockPayload = useMpv2 ? mpv2Record(shell.length, video.bytes.length) : video.bytes;
  const { file, payloadOffsets } = appendSeft(base, [
    { type: 0x0a01, name: 'Image_UTC_Data', payload: new TextEncoder().encode('1700000000000') },
    { type: 0x0a30, name: 'MotionPhoto_Data', payload: blockPayload },
  ]);
  // The block header and name sit immediately before the payload, so the real
  // offset is the one the trailer computes - not the end of the image.
  return {
    file,
    video: video.bytes,
    videoOffset: useMpv2 ? shell.length : payloadOffsets[1],
    imageLen: shell.length,
  };
}

/** A HEIC `meta` box with a primary image item and cdsc-linked Exif/XMP items. */
export function heicMeta(primaryLength) {
  const enc = (text) => new TextEncoder().encode(`${text}\0`);
  const infe = (id, type, name, contentType) => {
    const parts = [u32(2 << 24), u16(id), u16(0), fourcc(type), enc(name)];
    if (contentType) parts.push(enc(contentType));
    return box('infe', ...parts);
  };
  return box(
    'meta',
    u32(0),
    box('pitm', u32(0), u16(1)),
    // Real Samsung files leave every item name empty, and the `cdsc` references
    // link the Exif and XMP items - never a video - to the primary image.
    box(
      'iinf',
      u32(0),
      u16(3),
      infe(1, 'hvc1', ''),
      infe(2, 'Exif', ''),
      infe(3, 'mime', '', 'application/rdf+xml'),
    ),
    box('iloc', u32(0), new Uint8Array([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(0), u32(primaryLength)),
    box('iref', u32(0), box('cdsc', u16(2), u16(1), u16(1)), box('cdsc', u16(3), u16(1), u16(1))),
    box('iprp', box('ipco', box('ispe', u32(0), u32(4032), u32(3024)))),
  );
}

/** A HEIC with the primary image and whatever trailing boxes the caller builds. */
export function heicWithTrailing(buildTrailing, { primarySize = 3000 } = {}) {
  const ftypBox = ftyp('heic', ['heic', 'mif1']);
  const metaBox = heicMeta(primarySize);
  const trailingOffset = ftypBox.length + metaBox.length + 8 + primarySize;
  const built = buildTrailing(trailingOffset);
  const trailing = built?.file ?? built;
  const file = concat([
    ftypBox,
    metaBox,
    box('mdat', new Uint8Array(primarySize).fill(0x11)),
    trailing,
  ]);
  return {
    file,
    trailingOffset,
    trailing,
    video: built?.bytes ?? null,
    videoOffset: built?.offset ?? trailingOffset,
  };
}

/**
 * Motion Photo 1.0 for ISOBMFF: a top-level `mpvd` box holding the whole MP4.
 * Pass `video` to embed media supplied by the caller (ffmpeg output), or
 * `payload` to have a synthetic one built.
 */
export function heicWithMpvd({ payload = 700, moovAtFront = false, video } = {}) {
  return heicWithTrailing((offset) => {
    const bytes = video
      ? typeof video === 'function'
        ? video(offset + 8)
        : video
      : buildMp4({ payload, moovAtFront, baseOffset: offset + 8 }).bytes;
    return { file: box('mpvd', bytes), bytes, offset: offset + 8 };
  });
}

/**
 * Samsung's HEIC: a top-level `mpvd` box holding `[MP4][sefd]`, where the
 * `sefd` carries a SEFT trailer whose `MotionPhoto_Data` block is a 12-byte
 * `mpv2` record naming the video's real extent.
 */
export function samsungHeicMpvdSeft({ payload = 700, video } = {}) {
  return heicWithTrailing((offset) => {
    const videoOffset = offset + 8;
    const bytes = video ?? buildMp4({ payload, moovAtFront: false, baseOffset: videoOffset }).bytes;
    const { file: seft } = appendSeft(new Uint8Array(0), [
      { type: 0x0a30, name: 'MotionPhoto_Data', payload: mpv2Record(videoOffset, bytes.length) },
    ]);
    return { file: box('mpvd', bytes, box('sefd', seft)), bytes, offset: videoOffset };
  });
}

/** Samsung's 2020 HEIC: a top-level `sefd` box holding the trailer and the MP4. */
export function samsungHeicSefd({ payload = 700, video } = {}) {
  return heicWithTrailing((offset) => {
    const bytes = video ?? buildMp4({ payload, moovAtFront: false, baseOffset: offset + 8 + 24 }).bytes;
    // The trailer block *is* the video region: its header sits right before it.
    const { file: seft } = appendSeft(new Uint8Array(0), [
      { type: 0x0a30, name: 'MotionPhoto_Data', payload: bytes },
    ]);
    const videoOffset = offset + 8 + 8 + 'MotionPhoto_Data'.length;
    return { file: box('sefd', concat([bytes, seft])), bytes, offset: videoOffset };
  });
}

// ------------------------------------------------------------------ EXIF
//
// A minimal APP1 EXIF segment carrying one tag: Orientation. Enough to build a
// rotated fixture without an EXIF library, and enough for the viewer to have to
// honour it.

export function exifApp1(orientation, thumbnail) {
  const thumb = thumbnail ?? new Uint8Array(0);
  // IFD0: Orientation. IFD1: the embedded preview. Offsets are relative to the
  // TIFF header, and the layout is fixed so they can be computed up front.
  const ifd0At = 8;
  const ifd0Len = 2 + 12 + 4;
  const ifd1At = ifd0At + ifd0Len;
  const ifd1Len = 2 + 2 * 12 + 4;
  const thumbAt = thumb.length ? ifd1At + ifd1Len : 0;

  const ifd0 = concat([
    u16(1),
    u16(0x0112), u16(3), u32(1), u16(orientation), new Uint8Array(2),
    u32(thumb.length ? ifd1At : 0),
  ]);
  const ifd1 = thumb.length
    ? concat([
        u16(2),
        u16(0x0201), u16(4), u32(1), u32(thumbAt),
        u16(0x0202), u16(4), u32(1), u32(thumb.length),
        u32(0),
      ])
    : new Uint8Array(0);

  const tiff = concat([
    new TextEncoder().encode('MM'), // big endian
    u16(42),
    u32(ifd0At),
    ifd0,
    ifd1,
    thumb,
  ]);
  const body = concat([new TextEncoder().encode('Exif\0\0'), tiff]);
  return concat([new Uint8Array([0xff, 0xe1]), u16(body.length + 2), body]);
}

/**
 * Splices an EXIF block into a JPEG, right after SOI.
 * Pass `thumbnail` to also add an IFD1 embedded preview, which is what a camera
 * writes and what a tile is usually drawn from.
 */
export function withExifOrientation(jpeg, orientation, thumbnail) {
  return concat([jpeg.subarray(0, 2), exifApp1(orientation, thumbnail), jpeg.subarray(2)]);
}

/**
 * A plain HEIC: a grid of HEVC image tiles and nothing else. This is what a
 * normal Samsung or Apple photo looks like, and it must classify as a still -
 * `hvc1` items in a HEIC are *images*, not video.
 */
export function heicGridOnly({ tileSize = 900, tiles = 3 } = {}) {
  const enc = (text) => new TextEncoder().encode(`${text}\0`);
  const infe = (id, type, name, contentType) => {
    const parts = [u32(2 << 24), u16(id), u16(0), fourcc(type), enc(name)];
    if (contentType) parts.push(enc(contentType));
    return box('infe', ...parts);
  };
  const tileBytes = new Uint8Array(tileSize).fill(0x5a);
  const itemCount = tiles + 3; // grid + tiles + Exif + XMP
  const exifId = 2 + tiles;
  const xmpId = 3 + tiles;

  const iinf = box(
    'iinf',
    u32(0),
    u16(itemCount),
    infe(1, 'grid', ''),
    ...Array.from({ length: tiles }, (_, i) => infe(2 + i, 'hvc1', '')),
    infe(exifId, 'Exif', ''),
    infe(xmpId, 'mime', '', 'application/rdf+xml'),
  );
  const pitm = box('pitm', u32(0), u16(1));
  // The Exif item gets an extent too, which is what a real file looks like.
  const ispe = box('iprp', box('ipco', box('ispe', u32(0), u32(4032), u32(3024))));

  /** iloc version 0: two size bytes, then (id, data_ref, count, offset, length). */
  const buildMeta = (tileOffset, gridOffset, exifOffset, exifLength) => {
    const entries = [
      concat([u16(1), u16(0), u16(1), u32(gridOffset), u32(8)]),
      ...Array.from({ length: tiles }, (_, i) =>
        concat([u16(2 + i), u16(0), u16(1), u32(tileOffset + i * tileSize), u32(tileSize)]),
      ),
      concat([u16(exifId), u16(0), u16(1), u32(exifOffset), u32(exifLength)]),
    ];
    const iloc = box('iloc', u32(0), new Uint8Array([0x44, 0x00]), u16(entries.length), ...entries);
    const dimg = box('dimg', u16(1), u16(tiles), ...Array.from({ length: tiles }, (_, i) => u16(2 + i)));
    const cdsc = box('cdsc', u16(exifId), u16(1), u16(1));
    return box('meta', u32(0), pitm, iinf, iloc, box('iref', u32(0), dimg, cdsc), ispe);
  };

  const ftypBox = ftyp('heic', ['heic', 'mif1']);
  const probeMeta = buildMeta(0, 0, 0, 0);
  const gridOffset = ftypBox.length + probeMeta.length + 8;
  const tileOffset = gridOffset + 8;
  const exifOffset = tileOffset + tiles * tileSize;
  const exifLength = 64;
  const metaBox = buildMeta(tileOffset, gridOffset, exifOffset, exifLength);
  const mdat = box(
    'mdat',
    new Uint8Array(8).fill(0x00),
    ...Array.from({ length: tiles }, () => tileBytes),
    new Uint8Array(exifLength).fill(0x22),
  );
  return { file: concat([ftypBox, metaBox, mdat]), tileOffset, tileSize };
}
