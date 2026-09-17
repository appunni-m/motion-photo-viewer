//! Minimal TIFF/EXIF reading: identity, capture time, dimensions, the embedded
//! thumbnail, and the maker-note location.
//!
//! Deliberately narrow. GPS and other personal fields are never read, which is
//! both a privacy property and a performance one: the whole point is to fill a
//! grid with a few strings and a cheap thumbnail source.

use crate::bits::Sparse;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Exif {
    pub make: Option<String>,
    pub model: Option<String>,
    pub software: Option<String>,
    pub lens: Option<String>,
    pub datetime: Option<String>,
    pub datetime_original: Option<String>,
    pub orientation: Option<u16>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// EXIF thumbnail: absolute `(offset, length)` of an embedded JPEG.
    pub thumb: Option<(u64, u64)>,
    /// Orientation recorded for the thumbnail itself. Usually absent: the
    /// thumbnail is a copy of the stored pixels and needs the *main* image's
    /// orientation applied by whoever draws it.
    pub thumb_orientation: Option<u16>,
    /// Absolute `(offset, length)` of the maker note, for vendor markers.
    pub maker_note: Option<(u64, u64)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Endian {
    Little,
    Big,
}

impl Endian {
    fn u16(self, b: &[u8]) -> u16 {
        match self {
            Endian::Little => u16::from_le_bytes([b[0], b[1]]),
            Endian::Big => u16::from_be_bytes([b[0], b[1]]),
        }
    }

    fn u32(self, b: &[u8]) -> u32 {
        match self {
            Endian::Little => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            Endian::Big => u32::from_be_bytes([b[0], b[1], b[2], b[3]]),
        }
    }
}

const MAX_ENTRIES: u32 = 1024;
const MAX_IFDS: u8 = 4;

struct Tiff<'a> {
    s: &'a Sparse<'a>,
    base: u64,
    end: u64,
    endian: Endian,
}

impl<'a> Tiff<'a> {
    fn u16(&self, at: u64) -> Option<u16> {
        self.s.read(at, 2).map(|b| self.endian.u16(b))
    }

    fn u32(&self, at: u64) -> Option<u32> {
        self.s.read(at, 4).map(|b| self.endian.u32(b))
    }

    fn in_range(&self, at: u64, len: u64) -> bool {
        at >= self.base && at.checked_add(len).map(|e| e <= self.end).unwrap_or(false)
    }
}

/// `tiff_off` is the absolute offset of the TIFF header (just past `Exif\0\0`),
/// `tiff_len` the number of bytes available for it.
pub fn parse(s: &Sparse, tiff_off: u64, tiff_len: u64) -> Option<Exif> {
    let order = s.read(tiff_off, 2)?;
    let endian = match order {
        b"II" => Endian::Little,
        b"MM" => Endian::Big,
        _ => return None,
    };
    let t = Tiff {
        s,
        base: tiff_off,
        end: tiff_off + tiff_len,
        endian,
    };
    if t.u16(tiff_off + 2)? != 42 {
        return None;
    }
    let mut out = Exif::default();
    let mut ifd = t.u32(tiff_off + 4)? as u64;
    let mut depth = 0u8;
    while depth < MAX_IFDS {
        depth += 1;
        if ifd == 0 || !t.in_range(tiff_off + ifd, 2) {
            break;
        }
        let Some(next) = walk_ifd(&t, tiff_off + ifd, depth, &mut out) else {
            break;
        };
        ifd = next as u64;
    }
    Some(out)
}

fn walk_ifd(t: &Tiff, ifd_off: u64, depth: u8, out: &mut Exif) -> Option<u32> {
    let count = t.u16(ifd_off)? as u32;
    if count > MAX_ENTRIES {
        return None;
    }
    let mut exif_ifd = None;
    let mut thumb_off = None;
    let mut thumb_len = None;
    // IFD1 is the thumbnail IFD; its tags mean something different.
    let is_thumbnail_ifd = depth >= 2;
    for i in 0..count {
        let entry = ifd_off + 2 + (i as u64) * 12;
        if !t.in_range(entry, 12) {
            break;
        }
        let tag = t.u16(entry)?;
        let typ = t.u16(entry + 2)?;
        let n = t.u32(entry + 4)?;
        let value_at = entry + 8;
        if is_thumbnail_ifd {
            match tag {
                0x0201 => thumb_off = read_u32(t, typ, n, value_at),
                0x0202 => thumb_len = read_u32(t, typ, n, value_at),
                0x0112 => out.thumb_orientation = read_u32(t, typ, n, value_at).map(|v| v as u16),
                _ => {}
            }
            continue;
        }
        match tag {
            0x010f => out.make = read_ascii(t, typ, n, value_at),
            0x0110 => out.model = read_ascii(t, typ, n, value_at),
            0x0131 => out.software = read_ascii(t, typ, n, value_at),
            0x0132 => out.datetime = read_ascii(t, typ, n, value_at),
            0x0112 => out.orientation = read_u32(t, typ, n, value_at).map(|v| v as u16),
            0x0100 => out.width = read_u32(t, typ, n, value_at),
            0x0101 => out.height = read_u32(t, typ, n, value_at),
            0x8769 => exif_ifd = read_u32(t, typ, n, value_at),
            _ => {}
        }
        // The Exif sub-IFD carries the interesting capture fields and the
        // maker note. Walk it as a plain IFD at depth 1.
        if tag == 0x8769 {
            if let Some(sub) = exif_ifd {
                let sub_off = t.base + sub as u64;
                if t.in_range(sub_off, 2) {
                    walk_exif_ifd(t, sub_off, out);
                }
            }
        }
    }
    if let (Some(o), Some(l)) = (thumb_off, thumb_len) {
        if l > 0 && t.in_range(t.base + o as u64, l as u64) {
            out.thumb = Some((t.base + o as u64, l as u64));
        }
    }
    let next = t.u32(ifd_off + 2 + (count as u64) * 12)?;
    Some(next)
}

fn walk_exif_ifd(t: &Tiff, ifd_off: u64, out: &mut Exif) {
    let Some(count) = t.u16(ifd_off) else {
        return;
    };
    for i in 0..count.min(MAX_ENTRIES as u16) {
        let entry = ifd_off + 2 + (i as u64) * 12;
        if !t.in_range(entry, 12) {
            return;
        }
        let (Some(tag), Some(typ), Some(n)) = (t.u16(entry), t.u16(entry + 2), t.u32(entry + 4))
        else {
            return;
        };
        let value_at = entry + 8;
        match tag {
            0x9003 => out.datetime_original = read_ascii(t, typ, n, value_at),
            0xa002 => out.width = out.width.or(read_u32(t, typ, n, value_at)),
            0xa003 => out.height = out.height.or(read_u32(t, typ, n, value_at)),
            0xa434 => out.lens = read_ascii(t, typ, n, value_at),
            0x927c => {
                if let Some((off, len)) = value_location(t, typ, n, value_at) {
                    out.maker_note = Some((off, len));
                }
            }
            _ => {}
        }
    }
}

fn type_size(typ: u16) -> u64 {
    match typ {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

/// Where an entry's bytes actually live, when they do not fit inline.
fn value_location(t: &Tiff, typ: u16, n: u32, value_at: u64) -> Option<(u64, u64)> {
    let size = type_size(typ).checked_mul(n as u64)?;
    if size == 0 {
        return None;
    }
    if size <= 4 {
        return Some((value_at, size));
    }
    let off = t.u32(value_at)? as u64;
    let abs = t.base + off;
    if !t.in_range(abs, size) {
        return None;
    }
    Some((abs, size))
}

fn read_ascii(t: &Tiff, typ: u16, n: u32, value_at: u64) -> Option<String> {
    if typ != 2 && typ != 7 {
        return None;
    }
    let n = n.min(256);
    let (off, size) = if type_size(typ) * n as u64 <= 4 {
        (value_at, n as u64)
    } else {
        let o = t.u32(value_at)? as u64;
        (t.base + o, n as u64)
    };
    let bytes = t.s.read(off, size as usize)?;
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let s = String::from_utf8_lossy(&bytes[..end]).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn read_u32(t: &Tiff, typ: u16, n: u32, value_at: u64) -> Option<u32> {
    if n == 0 {
        return None;
    }
    match typ {
        3 => t.u16(value_at).map(u32::from),
        4 => t.u32(value_at),
        9 => t.s.read(value_at, 4).map(|b| {
            let v = t.endian.u32(b) as i32;
            v.unsigned_abs()
        }),
        1 | 7 => t.s.byte(value_at).map(u32::from),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::Sparse;

    /// Builds an EXIF blob with IFD0 (Make/Model/Orientation), an Exif sub-IFD
    /// (DateTimeOriginal/maker note) and IFD1 with a thumbnail reference.
    fn synth_exif(thumb_off: u32, thumb_len: u32) -> Vec<u8> {
        let make = b"Samsung\0";
        let model = b"SM-G998B\0";
        let dto = b"2023:05:04 11:22:33\0";
        let mn = b"MN\0\0\0\0\0\0";
        let ifd0_at = 8usize;
        let ifd0_len = 2 + 4 * 12 + 4;
        let data_at = ifd0_at + ifd0_len;
        let make_at = data_at;
        let model_at = make_at + make.len();
        let exif_ifd_at = model_at + model.len();
        let dto_at = exif_ifd_at + 2 + 2 * 12 + 4;
        let mn_at = dto_at + dto.len();
        let thumb_ifd_at = mn_at + mn.len();

        // Little-endian, everything laid out after the header.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&(ifd0_at as u32).to_le_bytes());

        tiff.extend_from_slice(&(4u16).to_le_bytes());
        // 0x010F Make
        tiff.extend_from_slice(&0x010fu16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&(make.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(make_at as u32).to_le_bytes());
        // 0x0110 Model
        tiff.extend_from_slice(&0x0110u16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&(model.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(model_at as u32).to_le_bytes());
        // 0x0112 Orientation = 6, inline
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&6u16.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        // 0x8769 Exif IFD pointer
        tiff.extend_from_slice(&0x8769u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&(exif_ifd_at as u32).to_le_bytes());
        // next IFD -> thumbnail IFD
        tiff.extend_from_slice(&(thumb_ifd_at as u32).to_le_bytes());
        assert_eq!(tiff.len(), data_at);
        tiff.extend_from_slice(make);
        tiff.extend_from_slice(model);
        assert_eq!(tiff.len(), exif_ifd_at);

        // Exif sub-IFD: DateTimeOriginal + MakerNote
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&0x9003u16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&(dto.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(dto_at as u32).to_le_bytes());
        tiff.extend_from_slice(&0x927cu16.to_le_bytes());
        tiff.extend_from_slice(&7u16.to_le_bytes());
        tiff.extend_from_slice(&(mn.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(mn_at as u32).to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        assert_eq!(tiff.len(), dto_at);
        tiff.extend_from_slice(dto);
        assert_eq!(tiff.len(), mn_at);
        tiff.extend_from_slice(mn);
        assert_eq!(tiff.len(), thumb_ifd_at);

        // Thumbnail IFD (IFD1)
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&0x0201u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&thumb_off.to_le_bytes());
        tiff.extend_from_slice(&0x0202u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&thumb_len.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff
    }

    #[test]
    fn reads_identity_capture_time_and_thumbnail() {
        let tiff = synth_exif(60_000, 4096);
        let mut file = b"Exif\0\0".to_vec();
        file.extend_from_slice(&tiff);
        file.resize(70_000, 0);
        let mut s = Sparse::new();
        s.add(&file, 0);
        // The APP1 segment holds the thumbnail too, so the addressable TIFF
        // range extends to the end of the file for this fixture.
        let exif = parse(&s, 6, (file.len() - 6) as u64).expect("parses");
        assert_eq!(exif.make.as_deref(), Some("Samsung"));
        assert_eq!(exif.model.as_deref(), Some("SM-G998B"));
        assert_eq!(exif.orientation, Some(6));
        assert_eq!(
            exif.datetime_original.as_deref(),
            Some("2023:05:04 11:22:33")
        );
        assert_eq!(exif.thumb, Some((6 + 60_000, 4096)));
        assert!(exif.maker_note.is_some());
        assert_eq!(exif.maker_note.unwrap().1, 8);
    }

    #[test]
    fn rejects_bad_headers() {
        let mut s = Sparse::new();
        let junk = b"XXXX-this-is-not-tiff-data";
        s.add(junk, 0);
        assert!(parse(&s, 0, junk.len() as u64).is_none());
    }

    #[test]
    fn hostile_ifd_counts_stay_bounded() {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&0xFFFFu16.to_le_bytes()); // absurd entry count
        tiff.resize(4096, 0);
        let mut s = Sparse::new();
        s.add(&tiff, 0);
        assert!(parse(&s, 0, tiff.len() as u64).is_some());
    }

    #[test]
    fn big_endian_files_parse() {
        // "MM" order with a single IFD0 entry: Make = "Google"
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM");
        tiff.extend_from_slice(&42u16.to_be_bytes());
        tiff.extend_from_slice(&8u32.to_be_bytes());
        tiff.extend_from_slice(&1u16.to_be_bytes());
        tiff.extend_from_slice(&0x010fu16.to_be_bytes());
        tiff.extend_from_slice(&2u16.to_be_bytes());
        tiff.extend_from_slice(&7u32.to_be_bytes());
        tiff.extend_from_slice(&26u32.to_be_bytes());
        tiff.extend_from_slice(&0u32.to_be_bytes());
        tiff.extend_from_slice(b"Google\0");
        let mut s = Sparse::new();
        s.add(&tiff, 0);
        let exif = parse(&s, 0, tiff.len() as u64).unwrap();
        assert_eq!(exif.make.as_deref(), Some("Google"));
    }
}
