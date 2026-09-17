//! MP4 structure reading, chunk-table reconstruction and `moov` patching.
//!
//! This module is what makes an extracted motion-photo video *playable* without
//! ever copying the media bytes into WebAssembly. Two facts drive the design:
//!
//! 1. A browser plays a `Blob` URL as a seekable resource, so `moov` may sit at
//!    either end of the file. There is no need for faststart.
//! 2. The byte range holding the samples can be derived from `stco`/`stsz`
//!    alone, so an extractor does not have to know where the original MP4
//!    container started. It only needs the `moov` (a few KiB) plus a verbatim
//!    copy of the sample span.
//!
//! The result is a plan of a few literal byte strings plus one or two
//! `File.slice()` ranges that JavaScript concatenates into a `Blob`. The bulk
//! data never crosses the WASM boundary.

use crate::bits::{boxes, child, BoxHdr, Sparse};

pub const VIDEO_SAMPLE_ENTRIES: [&[u8; 4]; 12] = [
    b"avc1", b"avc3", b"hvc1", b"hev1", b"mp4v", b"av01", b"vp08", b"vp09", b"dvh1", b"dvhe",
    b"encv", b"jpeg",
];

pub fn is_video_sample_entry(t: &[u8; 4]) -> bool {
    VIDEO_SAMPLE_ENTRIES.contains(&t)
}

#[derive(Clone, Debug, Default)]
pub struct Chunk {
    pub offset: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Trak {
    pub track_id: u32,
    pub handler: [u8; 4],
    pub codec_fourcc: Option<[u8; 4]>,
    pub codec_string: Option<String>,
    pub width: u32,
    pub height: u32,
    pub timescale: u32,
    pub duration: u64,
    pub sample_count: u64,
    pub sample_bytes: u64,
    pub chunks: Vec<Chunk>,
    /// `moof` fragments present: chunk offsets are not in `stco` and the
    /// rebuild path refuses to guess.
    pub fragmented: bool,
    /// Absolute offsets of the `stco`/`co64` payloads inside `moov`, with the
    /// entry count, so the rebuilder can patch them in place.
    pub chunk_offset_fields: Vec<ChunkOffsetField>,
}

#[derive(Clone, Copy, Debug)]
pub struct ChunkOffsetField {
    /// Absolute file offset of the entry-count field (4 bytes).
    pub count_at: u64,
    /// Absolute file offset of the first entry.
    pub entries_at: u64,
    pub entries: u32,
    pub wide: bool,
}

impl Trak {
    pub fn is_video(&self) -> bool {
        &self.handler == b"vide"
    }

    pub fn duration_ms(&self) -> Option<u64> {
        if self.timescale == 0 {
            return None;
        }
        Some(self.duration.saturating_mul(1000) / self.timescale as u64)
    }

    pub fn media_span(&self) -> Option<(u64, u64)> {
        let first = self.chunks.first()?;
        let last = self.chunks.last()?;
        let end = last.offset.checked_add(last.bytes)?;
        if end < first.offset {
            return None;
        }
        Some((first.offset, end - first.offset))
    }

    /// True when every chunk lies inside `[start, start+len)`.
    pub fn within(&self, start: u64, len: u64) -> bool {
        let end = start + len;
        !self.chunks.is_empty()
            && self
                .chunks
                .iter()
                .all(|c| c.offset >= start && c.offset + c.bytes <= end)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Moov {
    pub hdr: BoxHdrLike,
    pub timescale: u32,
    pub duration: u64,
    pub traks: Vec<Trak>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BoxHdrLike {
    pub start: u64,
    pub size: u64,
    pub data_start: u64,
    pub data_end: u64,
}

impl From<BoxHdr> for BoxHdrLike {
    fn from(b: BoxHdr) -> Self {
        BoxHdrLike {
            start: b.start,
            size: b.size,
            data_start: b.data_start,
            data_end: b.data_end,
        }
    }
}

impl Moov {
    pub fn video_trak(&self) -> Option<&Trak> {
        self.traks
            .iter()
            .filter(|t| t.is_video() && !t.chunks.is_empty())
            .max_by_key(|t| t.sample_bytes)
            .or_else(|| self.traks.iter().find(|t| t.is_video()))
    }

    pub fn duration_ms(&self) -> Option<u64> {
        if self.timescale == 0 || self.duration == 0 {
            return self.video_trak().and_then(|t| t.duration_ms());
        }
        Some(self.duration.saturating_mul(1000) / self.timescale as u64)
    }
}

fn fullbox(s: &Sparse, b: &BoxHdr) -> Option<(u8, u32)> {
    let v = s.byte(b.data_start)?;
    let flags = s.read(b.data_start + 1, 3)?;
    let flags = ((flags[0] as u32) << 16) | ((flags[1] as u32) << 8) | flags[2] as u32;
    Some((v, flags))
}

/// Parses a `moov` box. The `moov` bytes must be fully visible in the windows.
pub fn parse_moov(s: &Sparse, moov: BoxHdr) -> Option<Moov> {
    let mut out = Moov {
        hdr: moov.into(),
        ..Default::default()
    };
    let mvhd = child(s, &moov, b"mvhd")?;
    let (version, _) = fullbox(s, &mvhd)?;
    if version == 1 {
        out.timescale = s.u32(mvhd.data_start + 4 + 16)?;
        out.duration = s.u64(mvhd.data_start + 4 + 20)?;
    } else {
        out.timescale = s.u32(mvhd.data_start + 4 + 8)?;
        out.duration = s.u32(mvhd.data_start + 4 + 12)? as u64;
    }
    for trak in boxes(s, moov.data_start, moov.data_end).filter(|b| b.is(b"trak")) {
        if let Some(t) = parse_trak(s, &trak) {
            out.traks.push(t);
        }
    }
    Some(out)
}

fn parse_trak(s: &Sparse, trak: &BoxHdr) -> Option<Trak> {
    let mut out = Trak::default();
    if let Some(tkhd) = child(s, trak, b"tkhd") {
        let (version, _) = fullbox(s, &tkhd)?;
        let base = tkhd.data_start + 4;
        let id_at = if version == 1 { base + 16 } else { base + 8 };
        // From the track id to the display size: id(4) + reserved(4) +
        // duration(4 or 8) + reserved(8) + layer/group/volume/reserved(8) +
        // matrix(36). v0 and v1 differ before the id, not after it.
        let w_at = id_at + 64;
        out.track_id = s.u32(id_at).unwrap_or(0);
        // Width/height are 16.16 fixed point.
        if let (Some(w), Some(h)) = (s.u32(w_at), s.u32(w_at + 4)) {
            out.width = w >> 16;
            out.height = h >> 16;
        }
    }
    let mdia = child(s, trak, b"mdia")?;
    if let Some(hdlr) = child(s, &mdia, b"hdlr") {
        out.handler = s.fourcc(hdlr.data_start + 8).unwrap_or(*b"    ");
    }
    if let Some(mdhd) = child(s, &mdia, b"mdhd") {
        let (version, _) = fullbox(s, &mdhd)?;
        if version == 1 {
            out.timescale = s.u32(mdhd.data_start + 4 + 16).unwrap_or(0);
            out.duration = s.u64(mdhd.data_start + 4 + 20).unwrap_or(0);
        } else {
            out.timescale = s.u32(mdhd.data_start + 4 + 8).unwrap_or(0);
            out.duration = s.u32(mdhd.data_start + 4 + 12).unwrap_or(0) as u64;
        }
    }
    let minf = child(s, &mdia, b"minf")?;
    let stbl = child(s, &minf, b"stbl")?;

    if let Some(stsd) = child(s, &stbl, b"stsd") {
        if let Some((fourcc, codec)) = parse_stsd(s, &stsd) {
            out.codec_fourcc = Some(fourcc);
            out.codec_string = codec;
        }
    }

    // Sample sizes.
    let mut sizes: Vec<u32> = Vec::new();
    if let Some(stsz) = child(s, &stbl, b"stsz") {
        let uniform = s.u32(stsz.data_start + 4).unwrap_or(0);
        let count = s.u32(stsz.data_start + 8).unwrap_or(0);
        out.sample_count = count as u64;
        if uniform > 0 {
            out.sample_bytes = uniform as u64 * count as u64;
        } else {
            // Cap the table we materialise: a hostile or huge file must not
            // allocate unbounded memory. 500k samples is far beyond a motion
            // photo (a 10 s clip at 30 fps is 300).
            let n = count.min(500_000);
            sizes.reserve(n as usize);
            for i in 0..n {
                match s.u32(stsz.data_start + 12 + (i as u64) * 4) {
                    Some(v) => {
                        sizes.push(v);
                        out.sample_bytes += v as u64;
                    }
                    None => break,
                }
            }
        }
    }

    // Chunk offsets.
    if let Some(entry) = chunk_offset_box(s, &stbl) {
        let wide = entry.is(b"co64");
        let count = s.u32(entry.data_start + 4).unwrap_or(0);
        out.chunk_offset_fields.push(ChunkOffsetField {
            count_at: entry.data_start + 4,
            entries_at: entry.data_start + 8,
            entries: count,
            wide,
        });
        let n = count.min(500_000);
        let stride = if wide { 8u64 } else { 4u64 };
        for i in 0..n {
            let at = entry.data_start + 8 + (i as u64) * stride;
            let off = if wide {
                match s.u64(at) {
                    Some(v) => v,
                    None => break,
                }
            } else {
                match s.u32(at) {
                    Some(v) => v as u64,
                    None => break,
                }
            };
            out.chunks.push(Chunk {
                offset: off,
                bytes: 0,
            });
        }
    }

    // Samples per chunk, so each chunk's byte length can be computed.
    if let Some(stsc) = child(s, &stbl, b"stsc") {
        let count = s.u32(stsc.data_start + 4).unwrap_or(0).min(100_000);
        let mut runs: Vec<(u32, u32)> = Vec::with_capacity(count as usize);
        for i in 0..count {
            let at = stsc.data_start + 8 + (i as u64) * 12;
            match (s.u32(at), s.u32(at + 4)) {
                (Some(first), Some(per)) => runs.push((first, per)),
                _ => break,
            }
        }
        if !runs.is_empty() {
            let mut sample_idx: u64 = 0;
            for ci in 0..out.chunks.len() as u64 {
                let chunk_no = ci as u32 + 1;
                let per = runs
                    .iter()
                    .rev()
                    .find(|(first, _)| *first <= chunk_no)
                    .map(|(_, per)| *per)
                    .unwrap_or(0) as u64;
                let mut bytes = 0u64;
                for _ in 0..per {
                    match sizes.get(sample_idx as usize) {
                        Some(v) => bytes += *v as u64,
                        None => {
                            // Uniform sample size.
                            if out.sample_count > 0 && sizes.is_empty() {
                                bytes += out.sample_bytes / out.sample_count.max(1);
                            }
                        }
                    }
                    sample_idx += 1;
                }
                out.chunks[ci as usize].bytes = bytes;
            }
        } else if out.sample_count > 0 && !out.chunks.is_empty() {
            // No usable stsc: fall back to an even split, which is exact for
            // the single-chunk case that motion photos almost always use.
            let per = out.sample_count.div_ceil(out.chunks.len() as u64);
            let avg = out.sample_bytes / out.sample_count.max(1);
            for c in out.chunks.iter_mut() {
                c.bytes = per * avg;
            }
        }
    }

    out.fragmented = boxes(s, trak.data_start, trak.data_end)
        .any(|b| b.is(b"mvex") || b.is(b"moof"))
        || child(s, &mdia, b"moof").is_some();
    Some(out)
}

fn chunk_offset_box(s: &Sparse, stbl: &BoxHdr) -> Option<BoxHdr> {
    let mut found = None;
    for b in boxes(s, stbl.data_start, stbl.data_end) {
        if b.is(b"stco") || b.is(b"co64") {
            // The full entry table must be readable to be useful.
            let count = s.u32(b.data_start + 4)?;
            let stride = if b.is(b"co64") { 8u64 } else { 4u64 };
            let table_end = b.data_start + 8 + count as u64 * stride;
            if table_end > b.data_end {
                return None;
            }
            if found.is_none() {
                found = Some(b);
            }
        }
    }
    found
}

/// Reads the first sample entry of `stsd` and builds an RFC 6381 codec string
/// when the configuration box is present.
fn parse_stsd(s: &Sparse, stsd: &BoxHdr) -> Option<([u8; 4], Option<String>)> {
    let count = s.u32(stsd.data_start + 4)?;
    if count == 0 {
        return None;
    }
    let entry_start = stsd.data_start + 8;
    let size = s.u32(entry_start)? as u64;
    let fourcc = s.fourcc(entry_start + 4)?;
    if size < 16 {
        return None;
    }
    let entry = BoxHdr {
        typ: fourcc,
        start: entry_start,
        size,
        hdr_len: 8,
        data_start: entry_start + 8,
        data_end: entry_start + size,
    };
    // A VisualSampleEntry is not a plain box list: it begins with fixed fields
    // (reserved, data_reference_index, pre_defined, width, height, resolution,
    // reserved, frame_count, compressorname, depth) totalling 78 bytes, and only
    // then the codec configuration boxes. Walking from `data_start` would read
    // those fields as a box header.
    const VISUAL_SAMPLE_ENTRY_FIELDS: u64 = 78;
    let children_start = entry.data_start + VISUAL_SAMPLE_ENTRY_FIELDS;
    if children_start > entry.data_end {
        return Some((fourcc, None));
    }
    let codec = if fourcc == *b"avc1" || fourcc == *b"avc3" {
        boxes(s, children_start, entry.data_end)
            .find(|b| b.is(b"avcC"))
            .and_then(|c| avcc_string(s, &c, &fourcc))
    } else if fourcc == *b"hvc1" || fourcc == *b"hev1" {
        boxes(s, children_start, entry.data_end)
            .find(|b| b.is(b"hvcC"))
            .and_then(|c| hvcc_string(s, &c, &fourcc))
    } else {
        None
    };
    Some((fourcc, codec))
}

fn avcc_string(s: &Sparse, avcc: &BoxHdr, fourcc: &[u8; 4]) -> Option<String> {
    let b = s.read(avcc.data_start, 4)?;
    let mut out = String::with_capacity(16);
    out.push_str(&crate::bits::fourcc_string(fourcc));
    out.push('.');
    // RFC 6381: profile, compatibility and level as one six-digit hex triplet.
    for byte in [b[1], b[2], b[3]] {
        push_hex_byte(&mut out, byte);
    }
    Some(out)
}

fn hvcc_string(s: &Sparse, hvcc: &BoxHdr, fourcc: &[u8; 4]) -> Option<String> {
    let b = s.read(hvcc.data_start, 13)?;
    let profile_space = (b[1] >> 6) & 0x3;
    let tier = (b[1] >> 5) & 0x1;
    let profile_idc = b[1] & 0x1f;
    let compat = u32::from_be_bytes([b[2], b[3], b[4], b[5]]);
    let level = b[12];
    let mut out = String::with_capacity(24);
    out.push_str(&crate::bits::fourcc_string(fourcc));
    out.push('.');
    match profile_space {
        1 => out.push('A'),
        2 => out.push('B'),
        3 => out.push('C'),
        _ => {}
    }
    push_u32(&mut out, profile_idc as u32);
    out.push('.');
    // Compatibility flags are written most-significant-bit-first.
    let mut first = true;
    for i in (0..32).rev() {
        if (compat >> i) & 1 == 1 {
            if !first {
                out.push('.');
            }
            push_u32(&mut out, i);
            first = false;
        }
    }
    if first {
        out.push('0');
    }
    out.push('.');
    out.push(if tier == 1 { 'H' } else { 'L' });
    push_u32(&mut out, level as u32);
    out.push('.');
    for byte in &b[6..12] {
        push_hex_byte(&mut out, *byte);
    }
    Some(out)
}

fn push_u32(out: &mut String, v: u32) {
    let mut buf = [0u8; 10];
    let mut i = buf.len();
    let mut v = v;
    if v == 0 {
        out.push('0');
        return;
    }
    while v > 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    out.push_str(core::str::from_utf8(&buf[i..]).unwrap_or("0"));
}

fn push_hex_byte(out: &mut String, b: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push(HEX[(b >> 4) as usize] as char);
    out.push(HEX[(b & 0xf) as usize] as char);
}

/// Every `moov` box start that is visible in the windows and whose header is
/// structurally plausible.
pub fn find_moov_candidates(s: &Sparse, file_size: u64) -> Vec<BoxHdr> {
    let mut out = Vec::new();
    for w in s.windows() {
        for at in crate::bits::FindAll::new(w.data, b"moov", 8) {
            if at < 4 {
                continue;
            }
            let start = w.off + at as u64 - 4;
            // Require an explicit, plausible size: a declared size of 0 means
            // "runs to the end of the file", which would let a zero-filled run
            // of junk masquerade as a `moov`. No writer emits one that way.
            let Some(declared) = s.u32(start) else {
                continue;
            };
            if declared < 32 || declared as u64 > 32 * 1024 * 1024 {
                continue;
            }
            let Some(hdr) = crate::bits::read_box(s, start, file_size) else {
                continue;
            };
            if !hdr.is(b"moov") {
                continue;
            }
            // A moov for a short clip is a few KiB; refuse absurd sizes so a
            // coincidental "moov" inside mdat cannot win.
            if hdr.size < 32 || hdr.size > 32 * 1024 * 1024 {
                continue;
            }
            if !out.iter().any(|b: &BoxHdr| b.start == hdr.start) {
                out.push(hdr);
            }
        }
    }
    out.sort_by_key(|b| b.start);
    out
}

/// Builds a minimal but valid `ftyp` box.
pub fn build_ftyp(major: &[u8; 4], compatible: &[[u8; 4]]) -> Vec<u8> {
    let mut v = Vec::with_capacity(16 + compatible.len() * 4);
    let size = 16 + compatible.len() as u32 * 4;
    v.extend_from_slice(&size.to_be_bytes());
    v.extend_from_slice(b"ftyp");
    v.extend_from_slice(major);
    v.extend_from_slice(&0u32.to_be_bytes()); // minor_version
    for c in compatible {
        v.extend_from_slice(c);
    }
    v
}

/// Adds `delta` to every chunk offset in the given `moov` bytes.
///
/// `moov` must start at byte 0 of `bytes`, and `fields` are the chunk-offset
/// tables described relative to that start. Returns the number of entries
/// patched, or `None` when an entry would overflow its field width.
pub fn patch_moov(bytes: &mut [u8], fields: &[(usize, u32, bool)], delta: i64) -> Option<usize> {
    let mut patched = 0usize;
    for &(entries_at, count, wide) in fields {
        let stride = if wide { 8 } else { 4 };
        for i in 0..count as usize {
            let at = entries_at + i * stride;
            if wide {
                if at + 8 > bytes.len() {
                    return None;
                }
                let old = u64::from_be_bytes(bytes[at..at + 8].try_into().ok()?);
                let new = (old as i64).checked_add(delta)?;
                if !(0..=u64::MAX as i64).contains(&new) {
                    return None;
                }
                bytes[at..at + 8].copy_from_slice(&(new as u64).to_be_bytes());
            } else {
                if at + 4 > bytes.len() {
                    return None;
                }
                let old = u32::from_be_bytes(bytes[at..at + 4].try_into().ok()?);
                let new = (old as i64).checked_add(delta)?;
                if !(0..=u32::MAX as i64).contains(&new) {
                    return None;
                }
                bytes[at..at + 4].copy_from_slice(&(new as u32).to_be_bytes());
            }
            patched += 1;
        }
    }
    Some(patched)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bits::{read_box, Sparse};

    pub(crate) fn boxed(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(body.len() + 8);
        v.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    pub(crate) fn mdat_header(payload_len: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity(8);
        v.extend_from_slice(&(payload_len + 8).to_be_bytes());
        v.extend_from_slice(b"mdat");
        v
    }

    fn avc1_entry(width: u16, height: u16) -> Vec<u8> {
        let avcc = boxed(b"avcC", &[1, 0x42, 0xE0, 0x1E, 0xFF]);
        let mut e = Vec::new();
        e.extend_from_slice(&[0u8; 6]); // reserved
        e.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
        e.extend_from_slice(&[0u8; 2 + 2 + 12]); // pre_defined / reserved
        e.extend_from_slice(&width.to_be_bytes());
        e.extend_from_slice(&height.to_be_bytes());
        e.extend_from_slice(&0x0048_0000u32.to_be_bytes());
        e.extend_from_slice(&0x0048_0000u32.to_be_bytes());
        e.extend_from_slice(&0u32.to_be_bytes());
        e.extend_from_slice(&1u16.to_be_bytes()); // frame_count
        e.extend_from_slice(&[0u8; 32]); // compressorname
        e.extend_from_slice(&0x0018u16.to_be_bytes()); // depth
        e.extend_from_slice(&0xFFFFu16.to_be_bytes()); // pre_defined
        e.extend_from_slice(&avcc);
        let mut out = Vec::new();
        out.extend_from_slice(&((e.len() + 8) as u32).to_be_bytes());
        out.extend_from_slice(b"avc1");
        out.extend_from_slice(&e);
        out
    }

    /// A complete, parseable `moov` with one video trak, one chunk of
    /// `chunk_len` bytes at absolute file offset `chunk_off`.
    pub(crate) fn build_moov(chunk_off: u32, chunk_len: u32) -> Vec<u8> {
        let mut stsd_body = vec![0u8, 0, 0, 0];
        stsd_body.extend_from_slice(&1u32.to_be_bytes());
        stsd_body.extend_from_slice(&avc1_entry(1080, 1920));
        let stbl = boxed(
            b"stbl",
            &[
                boxed(b"stsd", &stsd_body),
                boxed(
                    b"stts",
                    &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0x03, 0x00],
                ),
                boxed(
                    b"stsc",
                    &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
                ),
                boxed(
                    b"stsz",
                    &[
                        0, 0, 0, 0, // version/flags
                        0, 0, 0, 0, // sample_size = 0 (per-sample table)
                        0, 0, 0, 1, // sample_count
                    ]
                    .iter()
                    .copied()
                    .chain(chunk_len.to_be_bytes())
                    .collect::<Vec<u8>>(),
                ),
                boxed(
                    b"stco",
                    &[
                        0, 0, 0, 0, // version/flags
                        0, 0, 0, 1, // entry_count
                    ]
                    .iter()
                    .copied()
                    .chain(chunk_off.to_be_bytes())
                    .collect::<Vec<u8>>(),
                ),
            ]
            .concat(),
        );
        let minf = boxed(b"minf", &stbl);
        let mut mdhd = vec![0u8, 0, 0, 0];
        mdhd.extend_from_slice(&[0u8; 8]); // creation/modification
        mdhd.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        mdhd.extend_from_slice(&0x300u32.to_be_bytes()); // duration
        mdhd.extend_from_slice(&[0u8; 4]); // language/quality
        let mut hdlr = vec![0u8; 8]; // version/flags + pre_defined
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0u8; 12]);
        let mdia = boxed(
            b"mdia",
            &[boxed(b"mdhd", &mdhd), boxed(b"hdlr", &hdlr), minf].concat(),
        );

        let mut tkhd = vec![0u8, 0, 0, 7];
        tkhd.extend_from_slice(&[0u8; 8]); // creation/modification (v0)
        tkhd.extend_from_slice(&1u32.to_be_bytes()); // track_id
        tkhd.extend_from_slice(&[0u8; 4]); // reserved
        tkhd.extend_from_slice(&0x300u32.to_be_bytes()); // duration
        tkhd.extend_from_slice(&[0u8; 8]); // reserved
        tkhd.extend_from_slice(&[0u8; 8]); // layer/group/volume/reserved
        tkhd.extend_from_slice(&[0u8; 36]); // matrix
        tkhd.extend_from_slice(&(1080u32 << 16).to_be_bytes());
        tkhd.extend_from_slice(&(1920u32 << 16).to_be_bytes());
        let trak = boxed(b"trak", &[boxed(b"tkhd", &tkhd), mdia].concat());

        let mut mvhd = vec![0u8, 0, 0, 0];
        mvhd.extend_from_slice(&[0u8; 8]);
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&0x300u32.to_be_bytes());
        mvhd.extend_from_slice(&[0u8; 80]);
        boxed(b"moov", &[boxed(b"mvhd", &mvhd), trak].concat())
    }

    /// A synthetic but structurally valid MP4: `ftyp`, one `mdat` holding 400
    /// bytes of samples, and the `moov` either first or last.
    pub(crate) fn synth_mp4(moov_at_front: bool) -> Vec<u8> {
        const PAYLOAD: u32 = 400;
        let ftyp = build_ftyp(b"isom", &[*b"isom", *b"mp41"]);
        let mdat_hdr = mdat_header(PAYLOAD);
        let moov_len = build_moov(0, PAYLOAD).len() as u64;
        let payload_at = if moov_at_front {
            ftyp.len() as u64 + moov_len + mdat_hdr.len() as u64
        } else {
            ftyp.len() as u64 + mdat_hdr.len() as u64
        };
        let moov = build_moov(payload_at as u32, PAYLOAD);
        let mut out = ftyp;
        if moov_at_front {
            out.extend_from_slice(&moov);
        }
        out.extend_from_slice(&mdat_hdr);
        out.extend_from_slice(&vec![0xAAu8; PAYLOAD as usize]);
        if !moov_at_front {
            out.extend_from_slice(&moov);
        }
        out
    }

    fn parse(data: &[u8]) -> Moov {
        let mut s = Sparse::new();
        s.add(data, 0);
        let hdr = find_moov_candidates(&s, data.len() as u64)
            .into_iter()
            .next()
            .expect("moov found");
        parse_moov(&s, hdr).expect("moov parses")
    }

    #[test]
    fn finds_and_parses_moov_at_end() {
        let data = synth_mp4(false);
        let moov = parse(&data);
        let trak = moov.video_trak().expect("video trak");
        assert_eq!(trak.handler, *b"vide");
        assert_eq!(trak.codec_string.as_deref(), Some("avc1.42E01E"));
        assert_eq!(trak.width, 1080);
        assert_eq!(trak.height, 1920);
        assert_eq!(trak.chunks.len(), 1);
        assert_eq!(trak.chunks[0].bytes, 400);
        assert_eq!(trak.sample_bytes, 400);
        assert_eq!(moov.duration_ms(), Some(768));
    }

    #[test]
    fn finds_and_parses_moov_at_front() {
        let data = synth_mp4(true);
        let moov = parse(&data);
        let trak = moov.video_trak().expect("video trak");
        let (start, len) = trak.media_span().expect("span");
        assert_eq!(len, 400);
        assert!(start + len <= data.len() as u64);
        assert!(trak.within(start, len));
        assert_eq!(&data[start as usize..start as usize + 4], &[0xAA; 4]);
    }

    #[test]
    fn reads_only_headers_from_a_partial_window() {
        // Head plus tail, no middle: a 8 MiB "video" must still parse, because
        // only box headers and the moov are ever touched.
        let ftyp = build_ftyp(b"isom", &[*b"isom"]);
        let payload_len = 8 * 1024 * 1024u32;
        let mdat_hdr = mdat_header(payload_len);
        let moov = build_moov(ftyp.len() as u32 + 8, payload_len);
        let mut data = ftyp.clone();
        data.extend_from_slice(&mdat_hdr);
        data.extend_from_slice(&vec![0x5Au8; payload_len as usize]);
        data.extend_from_slice(&moov);
        let mut s = Sparse::new();
        s.add(&data[..4096], 0);
        s.add(&data[data.len() - 4096..], (data.len() - 4096) as u64);
        let hdr = find_moov_candidates(&s, data.len() as u64)
            .into_iter()
            .next()
            .expect("moov visible in the tail");
        let parsed = parse_moov(&s, hdr).unwrap();
        let trak = parsed.video_trak().unwrap();
        assert_eq!(trak.chunks[0].bytes, payload_len as u64);
        assert_eq!(trak.media_span().unwrap().1, payload_len as u64);
    }

    #[test]
    fn rejects_random_moov_lookalikes() {
        let mut junk = vec![0u8; 4096];
        junk[1000..1004].copy_from_slice(b"moov");
        let mut s = Sparse::new();
        s.add(&junk, 0);
        assert!(find_moov_candidates(&s, junk.len() as u64).is_empty());
    }

    #[test]
    fn patches_chunk_offsets_in_place() {
        let data = synth_mp4(false);
        let mut s = Sparse::new();
        s.add(&data, 0);
        let hdr = find_moov_candidates(&s, data.len() as u64)
            .into_iter()
            .next()
            .unwrap();
        let moov = parse_moov(&s, hdr).unwrap();
        let trak = moov.video_trak().unwrap();
        let before = trak.chunks[0].offset;
        let fields: Vec<(usize, u32, bool)> = trak
            .chunk_offset_fields
            .iter()
            .map(|f| ((f.entries_at - hdr.start) as usize, f.entries, f.wide))
            .collect();
        let mut bytes = data[hdr.start as usize..hdr.data_end as usize].to_vec();
        assert_eq!(patch_moov(&mut bytes, &fields, 32), Some(1));
        let at = fields[0].0;
        let after = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as u64;
        assert_eq!(after, before + 32);
    }

    #[test]
    fn patch_overflow_is_reported_not_wrapped() {
        let mut bytes = vec![0u8; 16];
        bytes[0..4].copy_from_slice(&0xFFFF_FFF0u32.to_be_bytes());
        assert!(patch_moov(&mut bytes, &[(0, 1, false)], 0x100).is_none());
    }

    #[test]
    fn builds_valid_ftyp() {
        let f = build_ftyp(b"isom", &[*b"isom", *b"iso2", *b"avc1", *b"mp41"]);
        assert_eq!(&f[4..8], b"ftyp");
        assert_eq!(
            u32::from_be_bytes(f[0..4].try_into().unwrap()) as usize,
            f.len()
        );
        assert_eq!(&f[8..12], b"isom");
        assert_eq!(&f[16..20], b"isom");
    }

    #[test]
    fn hex_codec_strings_match_rfc6381() {
        assert_eq!(
            avcc_string_from(&[1, 0x64, 0x00, 0x28], b"avc1").as_deref(),
            Some("avc1.640028")
        );
    }

    fn avcc_string_from(bytes: &[u8], fourcc: &[u8; 4]) -> Option<String> {
        let boxed = boxed(b"avcC", bytes);
        let mut s = Sparse::new();
        s.add(&boxed, 0);
        let hdr = read_box(&s, 0, boxed.len() as u64).unwrap();
        avcc_string(&s, &hdr, fourcc)
    }
}
