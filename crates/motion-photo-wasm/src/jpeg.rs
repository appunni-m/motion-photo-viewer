//! JPEG segment walker.
//!
//! Only segment *headers* need to be read, so a small head window is enough for
//! EXIF, XMP and the position of the entropy-coded image data. The appended MP4
//! of a motion photo is never touched here.

use crate::bits::Sparse;

pub const MARKER_SOI: u8 = 0xd8;
pub const MARKER_EOI: u8 = 0xd9;
pub const MARKER_SOS: u8 = 0xda;

#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub marker: u8,
    /// Absolute offset of the `0xFF` byte that starts the marker.
    pub start: u64,
    /// Absolute offset of the first payload byte (after the length field).
    pub data_start: u64,
    /// Payload length in bytes.
    pub data_len: u64,
}

impl Segment {
    pub fn data_end(&self) -> u64 {
        self.data_start + self.data_len
    }
}

#[derive(Default)]
pub struct Jpeg {
    pub segments: Vec<Segment>,
    /// Offset of the SOS marker, when the walk reached it.
    pub sos: Option<u64>,
    /// Offset of the EOI marker, when the walk reached it.
    pub eoi: Option<u64>,
    /// True when the walk terminated on SOS or EOI instead of running out of
    /// readable bytes.
    pub complete: bool,
    /// Number of bytes the walk needed to finish (for adaptive window sizing).
    pub needed_bytes: u64,
}

pub fn is_jpeg(s: &Sparse) -> bool {
    s.starts_with(0, &[0xff, 0xd8, 0xff])
}

/// Walks the marker segments of a JPEG starting at offset 0.
pub fn walk(s: &Sparse) -> Jpeg {
    let mut out = Jpeg {
        segments: Vec::with_capacity(16),
        ..Default::default()
    };
    if !is_jpeg(s) {
        out.complete = false;
        return out;
    }
    let mut pos: u64 = 2;
    // A malformed file must not turn into unbounded work or memory.
    for _ in 0..1024 {
        let Some(marker) = s.byte(pos) else {
            out.needed_bytes = pos + 1;
            return out;
        };
        if marker != 0xff {
            out.needed_bytes = pos + 2;
            return out;
        }
        let Some(code) = s.byte(pos + 1) else {
            out.needed_bytes = pos + 2;
            return out;
        };
        if code == 0xff {
            // Fill byte; step forward one.
            pos += 1;
            continue;
        }
        if code == MARKER_SOS {
            out.sos = Some(pos);
            out.complete = true;
            out.needed_bytes = pos + 2;
            return out;
        }
        if code == MARKER_EOI {
            out.eoi = Some(pos);
            out.complete = true;
            out.needed_bytes = pos + 2;
            return out;
        }
        if code == 0x01 || (0xd0..=0xd7).contains(&code) {
            // Standalone markers carry no length.
            pos += 2;
            continue;
        }
        let Some(len) = s.u16(pos + 2) else {
            out.needed_bytes = pos + 4;
            return out;
        };
        if len < 2 {
            out.needed_bytes = pos + 4;
            return out;
        }
        let data_start = pos + 4;
        let data_len = (len - 2) as u64;
        out.segments.push(Segment {
            marker: code,
            start: pos,
            data_start,
            data_len,
        });
        pos = data_start + data_len;
        if pos > crate::probe::HARD_SCAN_LIMIT {
            out.needed_bytes = pos;
            return out;
        }
    }
    out.needed_bytes = pos;
    out
}

/// The embedded image payload of a JPEG: everything up to and including EOI, or
/// up to the appended video when EOI sits inside entropy-coded data that we
/// could not see. `None` when the answer is not knowable yet.
pub fn still_length(jpeg: &Jpeg, video_offset: Option<u64>) -> Option<u64> {
    if let Some(eoi) = jpeg.eoi {
        return Some(eoi + 2);
    }
    video_offset
}

pub fn is_exif_header(data: &[u8]) -> bool {
    data.len() >= 6 && &data[..6] == b"Exif\0\0"
}

/// `http://ns.adobe.com/xap/1.0/\0`
pub const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::Sparse;

    #[test]
    fn walks_standard_segments() {
        // SOI, APP0 "JFIF", COM, SOS
        let mut f = vec![0xff, 0xd8];
        f.extend_from_slice(&[0xff, 0xe0, 0x00, 0x06, b'J', b'F', b'I', b'F']);
        f.extend_from_slice(&[0xff, 0xfe, 0x00, 0x04, b'h', b'i']);
        f.extend_from_slice(&[0xff, 0xda, 0x00, 0x02]);
        let mut s = Sparse::new();
        s.add(&f, 0);
        let j = walk(&s);
        assert!(j.complete);
        assert_eq!(j.sos, Some(16));
        assert_eq!(j.segments.len(), 2);
        assert_eq!(j.segments[0].marker, 0xe0);
        assert_eq!(j.segments[0].data_len, 4);
        assert_eq!(
            &f[j.segments[0].data_start as usize..j.segments[0].data_end() as usize],
            b"JFIF"
        );
    }

    #[test]
    fn reports_needed_bytes_when_the_head_window_is_short() {
        let mut f = vec![0xff, 0xd8];
        f.extend_from_slice(&[0xff, 0xe1, 0x00, 0x40]); // claims 64 bytes of payload
        let mut s = Sparse::new();
        s.add(&f, 0);
        let j = walk(&s);
        assert!(!j.complete);
        assert_eq!(j.sos, None);
        assert_eq!(j.segments.len(), 1); // header was readable
        assert!(j.needed_bytes >= 8);
    }

    #[test]
    fn rejects_non_jpeg() {
        let f = b"not a jpeg at all";
        let mut s = Sparse::new();
        s.add(f, 0);
        assert!(!is_jpeg(&s));
        assert!(!walk(&s).complete);
    }
}
