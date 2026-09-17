//! Samsung's SEFT trailer and the motion-photo records it carries.
//!
//! Verified against real Galaxy files: the video of a Samsung motion photo is
//! *not* a HEIF item, not a second `ftyp`, and not simply "the rest of the
//! file". It is the payload of a named block inside a trailer that Samsung calls
//! SEFT, which ends every motion photo it writes. Two consequences matter:
//!
//! 1. The trailer sits *after* the video, so "video = last N bytes" and "the
//!    box chain ends at EOF" are both wrong by the size of that trailer.
//! 2. The trailer states the block's byte length, which gives the video's exact
//!    extent with no scanning at all.
//!
//! Layout (all lengths little-endian), from the end of the file backwards:
//!
//! ```text
//! ... blocks ...                        each block:
//! SEFH | u32 version | u32 count           u16 0x0000
//!   count x (12 bytes):                    u16le type
//!     u16 0x0000 | u16le type              u32le nameLen
//!     u32le negOffset                      name bytes
//!     u32le size                           payload (size - 8 - nameLen bytes)
//! u32le contentLen | "SEFT"             <- the file's last 8 bytes
//! ```
//!
//! `contentLen` is the size of the SEFH directory (its header plus its
//! entries), and the 8-byte footer follows it, so the directory is found
//! directly. A block's position is `dirPos - negOffset`.
//!
//! Newer devices (Galaxy S22 and later) put a 12-byte `mpv2` record in the
//! `MotionPhoto_Data` block instead of the MP4 itself: `"mpv2"`, then the
//! absolute offset and size of the video as big-endian `u32`s.

use crate::bits::{boxes, read_box, BoxHdr, Sparse};

/// Block type whose payload is the motion photo video (or the `mpv2` record).
pub const TYPE_MOTION_PHOTO_DATA: u16 = 0x0a30;
/// Block name Samsung writes for the same block.
pub const NAME_MOTION_PHOTO_DATA: &str = "MotionPhoto_Data";

#[derive(Clone, Debug)]
pub struct Block {
    pub typ: u16,
    pub name: String,
    /// False when the block header was outside every window and the name had to
    /// be taken from the block type.
    pub name_read: bool,
    /// Absolute offset of the payload.
    pub payload_off: u64,
    pub payload_len: u64,
}

#[derive(Clone, Debug)]
pub struct Trailer {
    /// Absolute offset of the `SEFH` directory.
    pub dir_pos: u64,
    pub version: u32,
    pub blocks: Vec<Block>,
}

/// Reads the SEFT trailer at the end of a file, if there is one.
///
/// Only the last few hundred bytes are touched: the footer names the directory
/// length and every block is placed by a relative offset.
pub fn parse(s: &Sparse, file_size: u64) -> Option<Trailer> {
    if file_size < 20 {
        return None;
    }
    if !s.starts_with(file_size - 4, b"SEFT") {
        return None;
    }
    let content_len = s.u32_le(file_size - 8)? as u64;
    if content_len < 8 || content_len > file_size {
        return None;
    }
    // On every real Galaxy file checked, `contentLen` is the size of the SEFH
    // directory (header plus entries) and the 8-byte footer follows it, so the
    // directory starts eight bytes earlier still. The alternative reading is
    // tried as well, because being wrong here costs a whole detection route.
    let mut dir_pos = None;
    for candidate in [
        file_size.saturating_sub(content_len + 8),
        file_size.saturating_sub(content_len),
    ] {
        if s.starts_with(candidate, b"SEFH") {
            dir_pos = Some(candidate);
            break;
        }
    }
    let dir_pos = dir_pos?;
    let version = s.u32_le(dir_pos + 4)?;
    let count = s.u32_le(dir_pos + 8)?;
    if count > 64 {
        return None;
    }
    let mut blocks = Vec::with_capacity(count as usize);
    for i in 0..count as u64 {
        let entry = dir_pos + 12 + i * 12;
        let typ = s.u16_le(entry + 2)?;
        let neg_offset = s.u32_le(entry + 4)? as u64;
        let size = s.u32_le(entry + 8)? as u64;
        if size < 8 {
            continue;
        }
        let Some(block_pos) = dir_pos.checked_sub(neg_offset) else {
            continue;
        };
        if block_pos >= dir_pos {
            continue;
        }
        // Block header: u16 marker, u16le type, u32le nameLen, name. For a
        // video the header sits megabytes before the trailer, outside every
        // window, so the name length has to come from the block type instead:
        // the type is the identifier, and Samsung always uses the same name.
        let declared_name_len = match s.u32_le(block_pos + 4) {
            Some(v) if v <= 256 => Some(v as u64),
            _ => None,
        };
        let (name_len, name_read) = match declared_name_len {
            Some(v) => (v, true),
            None if typ == TYPE_MOTION_PHOTO_DATA => (NAME_MOTION_PHOTO_DATA.len() as u64, false),
            None => continue,
        };
        let payload_off = block_pos + 8 + name_len;
        let payload_len = size.saturating_sub(8 + name_len);
        if payload_len == 0 || payload_off + payload_len > file_size {
            continue;
        }
        let name = if name_read {
            s.read(block_pos + 8, name_len as usize)
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default()
        } else {
            String::new()
        };
        blocks.push(Block {
            typ,
            name,
            name_read,
            payload_off,
            payload_len,
        });
    }
    Some(Trailer {
        dir_pos,
        version,
        blocks,
    })
}

impl Trailer {
    pub fn motion_block(&self) -> Option<&Block> {
        self.blocks
            .iter()
            .find(|b| b.typ == TYPE_MOTION_PHOTO_DATA || b.name == NAME_MOTION_PHOTO_DATA)
    }

    /// The exact byte range of the video, following the `mpv2` record when the
    /// block carries one instead of the media itself.
    pub fn video_range(&self, s: &Sparse, file_size: u64) -> Option<(u64, u64)> {
        let block = self.motion_block()?;
        // Newer devices: a 12-byte pointer record.
        if block.payload_len >= 12 {
            if let Some(record) = s.read(block.payload_off, 12) {
                if let Some(range) = parse_mpv2(record) {
                    if valid_range(range, file_size) {
                        return Some(range);
                    }
                }
            }
        }
        let range = (block.payload_off, block.payload_len);
        if valid_range(range, file_size) {
            Some(range)
        } else {
            None
        }
    }

    /// Block names worth showing: real ones when their header was readable, and
    /// the motion photo marker otherwise, since its type identifies it.
    pub fn markers(&self) -> Vec<String> {
        let mut out = Vec::new();
        for block in &self.blocks {
            if !block.name.is_empty() {
                out.push(block.name.clone());
            } else if block.typ == TYPE_MOTION_PHOTO_DATA {
                out.push(NAME_MOTION_PHOTO_DATA.to_string());
            }
        }
        out
    }
}

fn valid_range((off, len): (u64, u64), file_size: u64) -> bool {
    len > 0
        && off > 0
        && off
            .checked_add(len)
            .map(|e| e <= file_size)
            .unwrap_or(false)
}

/// `mpv2` | u32be absolute offset | u32be size.
pub fn parse_mpv2(bytes: &[u8]) -> Option<(u64, u64)> {
    if bytes.len() < 12 || &bytes[..4] != b"mpv2" {
        return None;
    }
    let off = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as u64;
    let len = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as u64;
    Some((off, len))
}

/// Finds a top-level `mpvd` box ("Motion Photo Video Data"), which is how
/// Motion Photo format 1.0 stores the video of a HEIC or AVIF still: a sibling
/// box at the end of the file whose payload is the whole MP4.
///
/// The box header is only found when it is inside a window, which is true for
/// small files; for large ones the SEFT/`mpv2` route or the sample table gets
/// there instead.
pub fn find_mpvd(s: &Sparse, file_size: u64) -> Option<BoxHdr> {
    for w in s.windows() {
        for at in crate::bits::FindAll::new(w.data, b"mpvd", 8) {
            if at < 4 {
                continue;
            }
            let start = w.off + at as u64 - 4;
            let Some(hdr) = read_box(s, start, file_size) else {
                continue;
            };
            if !hdr.is(b"mpvd") || hdr.size < 16 {
                continue;
            }
            return Some(hdr);
        }
    }
    None
}

/// Trims a trailing `sefd` box from an `mpvd` payload.
///
/// Samsung writes `[complete MP4][sefd box]` inside `mpvd`, where the `sefd`
/// holds a SEFT trailer with the real extent. Google's own extractor hands the
/// whole payload to an MP4 parser, which tolerates the extra box; being exact
/// is better, so the trailing box is excluded when it can be identified.
pub fn trim_trailing_sefd(s: &Sparse, payload_start: u64, payload_end: u64) -> u64 {
    let mut pos = payload_start;
    let mut last_sefd = None;
    for _ in 0..64 {
        if pos >= payload_end {
            break;
        }
        let Some(b) = read_box(s, pos, payload_end) else {
            return payload_end;
        };
        if b.is(b"sefd") {
            last_sefd = Some(b.start);
        }
        pos = b.data_end;
    }
    if pos == payload_end {
        last_sefd.unwrap_or(payload_end)
    } else {
        payload_end
    }
}

/// The box types at the top level of an ISOBMFF file, for diagnostics.
pub fn top_level(s: &Sparse, file_size: u64) -> Vec<String> {
    boxes(s, 0, file_size)
        .take(16)
        .map(|b| b.type_lossy())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn le16(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }

    fn le32(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }

    /// Builds a Samsung-style file: image, video, then a SEFT trailer holding a
    /// `MotionPhoto_Data` block with the video inline.
    pub(crate) fn synth_seft_file(video: &[u8], inline: bool) -> Vec<u8> {
        let image = vec![0x33u8; 512];
        let name = NAME_MOTION_PHOTO_DATA.as_bytes();
        // When the pointer variant is used the video sits after a filler, so the
        // record has to name that position, not the end of the image.
        let filler_len = if inline { 0 } else { 64 };
        let video_at = (image.len() + filler_len) as u64;

        // The block payload: the video itself, or a 12-byte mpv2 pointer.
        let payload: Vec<u8> = if inline {
            video.to_vec()
        } else {
            let mut rec = Vec::with_capacity(12);
            rec.extend_from_slice(b"mpv2");
            rec.extend_from_slice(&(video_at as u32).to_be_bytes());
            rec.extend_from_slice(&(video.len() as u32).to_be_bytes());
            rec
        };

        let mut file = image;
        if !inline {
            // The video lives outside the block in this variant.
            let mut filler = vec![0x44u8; filler_len];
            filler.extend_from_slice(video);
            file.extend_from_slice(&filler);
        }

        // One more block before the motion block, to prove offsets are relative.
        let utc_name = b"Image_UTC_Data";
        let utc_payload = b"1700000000000";
        let utc_block = block(0x0a01, utc_name, utc_payload);
        let motion_block = block(TYPE_MOTION_PHOTO_DATA, name, &payload);

        let mut body = Vec::new();
        body.extend_from_slice(&file);
        let utc_pos = body.len() as u64;
        body.extend_from_slice(&utc_block);
        let motion_pos = body.len() as u64;
        body.extend_from_slice(&motion_block);

        let dir_pos = body.len() as u64;
        let mut dir = Vec::new();
        dir.extend_from_slice(b"SEFH");
        dir.extend_from_slice(&le32(103));
        dir.extend_from_slice(&le32(2));
        for (typ, pos, size) in [
            (0x0a01u16, utc_pos, utc_block.len() as u32),
            (
                TYPE_MOTION_PHOTO_DATA,
                motion_pos,
                motion_block.len() as u32,
            ),
        ] {
            dir.extend_from_slice(&le16(0));
            dir.extend_from_slice(&le16(typ));
            dir.extend_from_slice(&le32((dir_pos - pos) as u32));
            dir.extend_from_slice(&le32(size));
        }
        body.extend_from_slice(&dir);
        // Verified against a real Galaxy S8 file: `contentLen` is the directory
        // itself (12-byte header + 12 bytes per entry), and the footer follows.
        let content_len = (body.len() as u64 - dir_pos) as u32;
        body.extend_from_slice(&le32(content_len));
        body.extend_from_slice(b"SEFT");
        body
    }

    fn block(typ: u16, name: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(&le16(typ));
        out.extend_from_slice(&le32(name.len() as u32));
        out.extend_from_slice(name);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn parses_a_trailer_with_an_inline_video() {
        let video = crate::mp4::tests::synth_mp4(true);
        let file = synth_seft_file(&video, true);
        let mut s = Sparse::new();
        s.add(&file[..1024.min(file.len())], 0);
        s.add(
            &file[file.len().saturating_sub(4096)..],
            file.len().saturating_sub(4096) as u64,
        );
        let trailer = parse(&s, file.len() as u64).expect("trailer");
        assert_eq!(trailer.version, 103);
        assert_eq!(trailer.blocks.len(), 2);
        assert_eq!(
            trailer.markers(),
            vec!["Image_UTC_Data", "MotionPhoto_Data"]
        );
        let (off, len) = trailer.video_range(&s, file.len() as u64).expect("range");
        assert_eq!(len, video.len() as u64);
        assert_eq!(&file[off as usize..(off + len) as usize], &video[..]);
    }

    #[test]
    fn follows_an_mpv2_pointer_record() {
        let video = crate::mp4::tests::synth_mp4(true);
        let file = synth_seft_file(&video, false);
        let mut s = Sparse::new();
        s.add(&file[..1024.min(file.len())], 0);
        s.add(
            &file[file.len().saturating_sub(4096)..],
            file.len().saturating_sub(4096) as u64,
        );
        let trailer = parse(&s, file.len() as u64).expect("trailer");
        let (off, len) = trailer.video_range(&s, file.len() as u64).expect("range");
        assert_eq!(len, video.len() as u64);
        assert_eq!(&file[off as usize..(off + len) as usize], &video[..]);
    }

    #[test]
    fn ignores_files_without_a_trailer() {
        let junk = vec![0u8; 4096];
        let mut s = Sparse::new();
        s.add(&junk, 0);
        assert!(parse(&s, junk.len() as u64).is_none());
    }

    #[test]
    fn ignores_a_bogus_content_length() {
        let mut file = vec![0u8; 4096];
        file[4088..4092].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        file[4092..4096].copy_from_slice(b"SEFT");
        let mut s = Sparse::new();
        s.add(&file, 0);
        assert!(parse(&s, file.len() as u64).is_none());
    }

    #[test]
    fn reads_the_mpv2_record() {
        let mut rec = Vec::new();
        rec.extend_from_slice(b"mpv2");
        rec.extend_from_slice(&1234u32.to_be_bytes());
        rec.extend_from_slice(&5678u32.to_be_bytes());
        assert_eq!(parse_mpv2(&rec), Some((1234, 5678)));
        assert_eq!(parse_mpv2(b"not a record"), None);
    }

    #[test]
    fn trims_a_trailing_sefd_box() {
        // ftyp + mdat + sefd
        let mut payload = crate::mp4::build_ftyp(b"isom", &[*b"isom"]);
        let mdat_at = payload.len();
        payload.extend_from_slice(&crate::mp4::tests::mdat_header(32));
        payload.extend_from_slice(&[0u8; 32]);
        let _ = mdat_at;
        let sefd_at = payload.len() as u64;
        payload.extend_from_slice(&crate::mp4::tests::boxed(b"sefd", &[0u8; 24]));
        let mut s = Sparse::new();
        s.add(&payload, 0);
        let end = trim_trailing_sefd(&s, 0, payload.len() as u64);
        assert_eq!(end, sefd_at);
    }
}
