//! HEIF/HEIC/AVIF `meta` box reading.
//!
//! Android's Motion Photo 1.0 format stores the video of an ISOBMFF still as an
//! *item*: a second payload described by `iloc`, tied to the primary image item
//! by an item reference. Reading `meta` is therefore enough to name the exact
//! byte range of the video without scanning the file, which is precisely what a
//! no-copy extractor wants.

use crate::bits::{boxes, child, BoxHdr, Sparse};
use crate::mp4::is_video_sample_entry;

#[derive(Clone, Debug, Default)]
pub struct Item {
    pub id: u32,
    pub item_type: [u8; 4],
    pub name: String,
    pub content_type: String,
    /// Absolute `(offset, length)` extents, in file order.
    pub extents: Vec<(u64, u64)>,
    /// True when this item's data lives in the file's `idat` box.
    pub in_idat: bool,
}

impl Item {
    pub fn type_str(&self) -> String {
        crate::bits::fourcc_string(&self.item_type)
    }

    pub fn total_len(&self) -> u64 {
        self.extents.iter().map(|e| e.1).sum()
    }

    pub fn start(&self) -> Option<u64> {
        self.extents.first().map(|e| e.0)
    }

    pub fn is_video(&self) -> bool {
        is_video_sample_entry(&self.item_type)
            || self.content_type.starts_with("video/")
            || self.item_type == *b"mime" && self.content_type.starts_with("video/")
    }

    /// True when the extents are laid out back to back, so the item can be
    /// treated as one contiguous byte range.
    pub fn contiguous(&self) -> bool {
        let mut expect = None;
        for (off, len) in &self.extents {
            if let Some(e) = expect {
                if *off != e {
                    return false;
                }
            }
            expect = Some(off + len);
        }
        true
    }
}

#[derive(Clone, Debug)]
pub struct ItemRef {
    pub ref_type: [u8; 4],
    pub from: u32,
    pub to: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub primary: Option<u32>,
    pub items: Vec<Item>,
    pub refs: Vec<ItemRef>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl Meta {
    pub fn item(&self, id: u32) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id)
    }

    /// Item IDs that the primary item points at with `cdsc` ("content
    /// describes"), the reference type Android uses to attach a motion photo
    /// video to its still.
    pub fn described_by_primary(&self) -> Vec<u32> {
        let Some(primary) = self.primary else {
            return Vec::new();
        };
        self.refs
            .iter()
            .filter(|r| r.from == primary && (&r.ref_type == b"cdsc" || &r.ref_type == b"auxl"))
            .map(|r| r.to)
            .collect()
    }

    /// The most likely motion-photo video item, if any.
    pub fn video_item(&self) -> Option<&Item> {
        let described = self.described_by_primary();
        // Prefer a cdsc-referenced item that also looks like video, then any
        // described item, then the largest video-typed item.
        let mut best: Option<&Item> = None;
        for item in &self.items {
            if Some(item.id) == self.primary {
                continue;
            }
            if !item.is_video() && !described.contains(&item.id) {
                continue;
            }
            if item.extents.is_empty() || item.in_idat {
                continue;
            }
            let better = match best {
                None => true,
                Some(b) => {
                    let rank =
                        |i: &Item| (described.contains(&i.id) as u8) * 2 + (i.is_video() as u8);
                    (rank(item), item.total_len()) > (rank(b), b.total_len())
                }
            };
            if better {
                best = Some(item);
            }
        }
        best
    }
}

pub fn is_isobmff(s: &Sparse) -> bool {
    s.starts_with(4, b"ftyp")
}

/// The major brand of an ISOBMFF file.
pub fn major_brand(s: &Sparse) -> Option<[u8; 4]> {
    if !is_isobmff(s) {
        return None;
    }
    s.fourcc(8)
}

pub fn is_heif_brand(brand: &[u8; 4]) -> bool {
    matches!(
        brand,
        b"heic"
            | b"heix"
            | b"hevc"
            | b"hevx"
            | b"heim"
            | b"heis"
            | b"hevm"
            | b"hevs"
            | b"mif1"
            | b"msf1"
            | b"mif2"
    )
}

pub fn is_avif_brand(brand: &[u8; 4]) -> bool {
    matches!(brand, b"avif" | b"avis")
}

pub fn is_mp4_brand(brand: &[u8; 4]) -> bool {
    matches!(
        brand,
        b"isom"
            | b"iso2"
            | b"iso4"
            | b"iso5"
            | b"iso6"
            | b"mp41"
            | b"mp42"
            | b"avc1"
            | b"dash"
            | b"3gp4"
            | b"3gp5"
            | b"3g2a"
            | b"M4V "
            | b"M4A "
            | b"qt  "
    )
}

/// Finds the `meta` box of an ISOBMFF still.
pub fn find_meta(s: &Sparse, file_size: u64) -> Option<BoxHdr> {
    boxes(s, 0, file_size).find(|b| b.is(b"meta"))
}

/// Parses the `meta` box, resolving `iloc` extents to absolute file offsets.
pub fn parse_meta(s: &Sparse, meta: &BoxHdr) -> Option<Meta> {
    let mut out = Meta::default();
    // `meta` is a FullBox: 4 bytes of version/flags before its children.
    let inner = BoxHdr {
        typ: *b"meta",
        start: meta.start,
        size: meta.size,
        hdr_len: meta.hdr_len + 4,
        data_start: meta.data_start + 4,
        data_end: meta.data_end,
    };
    if let Some(pitm) = child(s, &inner, b"pitm") {
        let version = s.byte(pitm.data_start)?;
        out.primary = if version == 0 {
            s.u16(pitm.data_start + 4).map(u32::from)
        } else {
            s.u32(pitm.data_start + 4)
        };
    }
    if let Some(iinf) = child(s, &inner, b"iinf") {
        parse_iinf(s, &iinf, &mut out);
    }
    let idat = child(s, &inner, b"idat");
    if let Some(iloc) = child(s, &inner, b"iloc") {
        parse_iloc(s, &iloc, idat.as_ref(), &mut out);
    }
    if let Some(iref) = child(s, &inner, b"iref") {
        parse_iref(s, &iref, &mut out);
    }
    if let Some(iprp) = child(s, &inner, b"iprp") {
        if let Some(ipco) = child(s, &iprp, b"ipco") {
            for prop in boxes(s, ipco.data_start, ipco.data_end) {
                if prop.is(b"ispe") {
                    // FullBox: version/flags + width + height
                    if let (Some(w), Some(h)) =
                        (s.u32(prop.data_start + 4), s.u32(prop.data_start + 8))
                    {
                        if w > 0 && h > 0 && w < 1_000_000 && h < 1_000_000 {
                            out.width = Some(w);
                            out.height = Some(h);
                            break;
                        }
                    }
                }
            }
        }
    }
    Some(out)
}

fn parse_iinf(s: &Sparse, iinf: &BoxHdr, out: &mut Meta) {
    let version = s.byte(iinf.data_start).unwrap_or(0);
    let (count, mut pos) = if version == 0 {
        (
            s.u16(iinf.data_start + 4).unwrap_or(0) as u32,
            iinf.data_start + 6,
        )
    } else {
        (s.u32(iinf.data_start + 4).unwrap_or(0), iinf.data_start + 8)
    };
    // Cap: a still image has a handful of items; a hostile file must not make
    // us walk a million of them.
    let count = count.min(512);
    let mut seen = 0u32;
    while seen < count && pos < iinf.data_end {
        let Some(infe) = crate::bits::read_box(s, pos, iinf.data_end) else {
            break;
        };
        if !infe.is(b"infe") {
            pos = infe.data_end;
            continue;
        }
        seen += 1;
        pos = infe.data_end;
        let version = s.byte(infe.data_start).unwrap_or(2);
        let mut p = infe.data_start + 4;
        let id = if version >= 3 {
            let v = s.u32(p);
            p += 4;
            v
        } else {
            let v = s.u16(p).map(u32::from);
            p += 2;
            v
        };
        let Some(id) = id else { continue };
        p += 2; // item_protection_index
        let mut item = Item {
            id,
            ..Default::default()
        };
        if version >= 2 {
            item.item_type = s.fourcc(p).unwrap_or(*b"    ");
            p += 4;
            let (name, next) = read_cstr(s, p, infe.data_end);
            item.name = name;
            p = next;
            if &item.item_type == b"mime" {
                let (ct, next) = read_cstr(s, p, infe.data_end);
                item.content_type = ct;
                p = next;
            }
        } else {
            let (name, next) = read_cstr(s, p, infe.data_end);
            item.name = name;
            p = next;
            let (ct, next) = read_cstr(s, p, infe.data_end);
            item.content_type = ct;
            p = next;
            // Version 0/1 `infe` carries no item type; the content type is the
            // only classification available.
            item.item_type = *b"mime";
        }
        let _ = p;
        if let Some(existing) = out.items.iter_mut().find(|i| i.id == id) {
            *existing = item;
        } else {
            out.items.push(item);
        }
    }
}

/// `iloc` version 0/1/2, construction methods 0 (file), 1 (`idat`), 2 (item).
fn parse_iloc(s: &Sparse, iloc: &BoxHdr, idat: Option<&BoxHdr>, out: &mut Meta) {
    let version = s.byte(iloc.data_start).unwrap_or(0);
    let Some(sizes) = s.read(iloc.data_start + 4, 2) else {
        return;
    };
    let offset_size = (sizes[0] >> 4) as u64;
    let length_size = (sizes[0] & 0xf) as u64;
    let base_offset_size = (sizes[1] >> 4) as u64;
    let index_size = if version == 1 || version == 2 {
        (sizes[1] & 0xf) as u64
    } else {
        0
    };
    let mut p = iloc.data_start + 6;
    let count = if version < 2 {
        s.u16(p).map(u32::from).unwrap_or(0)
    } else {
        s.u32(p).unwrap_or(0)
    };
    p += if version < 2 { 2 } else { 4 };
    let count = count.min(512);
    for _ in 0..count {
        let id = if version < 2 {
            let v = s.u16(p).map(u32::from);
            p += 2;
            v
        } else {
            let v = s.u32(p);
            p += 4;
            v
        };
        let Some(id) = id else { return };
        let mut construction_method = 0u16;
        if version == 1 || version == 2 {
            construction_method = s.u16(p).unwrap_or(0) & 0xf;
            p += 2;
        }
        p += 2; // data_reference_index
        let Some(base) = read_sized(s, p, base_offset_size) else {
            return;
        };
        p += base_offset_size;
        let Some(extent_count) = s.u16(p) else {
            return;
        };
        p += 2;
        let mut extents = Vec::new();
        for _ in 0..extent_count.min(64) {
            if index_size > 0 {
                p += index_size; // extent_index, unused here
            }
            let Some(off) = read_sized(s, p, offset_size) else {
                return;
            };
            p += offset_size;
            let Some(len) = read_sized(s, p, length_size) else {
                return;
            };
            p += length_size;
            let absolute = match construction_method {
                1 => idat.map(|d| d.data_start).unwrap_or(0) + base + off,
                _ => base + off,
            };
            extents.push((absolute, len));
        }
        let in_idat = construction_method == 1;
        if let Some(item) = out.items.iter_mut().find(|i| i.id == id) {
            item.extents = extents;
            item.in_idat = in_idat;
        } else {
            out.items.push(Item {
                id,
                extents,
                in_idat,
                ..Default::default()
            });
        }
    }
}

fn read_sized(s: &Sparse, at: u64, size: u64) -> Option<u64> {
    match size {
        0 => Some(0),
        1 => s.byte(at).map(u64::from),
        2 => s.u16(at).map(u64::from),
        3 => s
            .read(at, 3)
            .map(|b| ((b[0] as u64) << 16) | ((b[1] as u64) << 8) | b[2] as u64),
        4 => s.u32(at).map(u64::from),
        8 => s.u64(at),
        _ => None,
    }
}

fn parse_iref(s: &Sparse, iref: &BoxHdr, out: &mut Meta) {
    let version = s.byte(iref.data_start).unwrap_or(0);
    for r in boxes(s, iref.data_start + 4, iref.data_end) {
        let Some(from) = (if version == 0 {
            s.u16(r.data_start).map(u32::from)
        } else {
            s.u32(r.data_start)
        }) else {
            continue;
        };
        let Some(count) = s.u16(r.data_start + if version == 0 { 2 } else { 4 }) else {
            continue;
        };
        let mut p = r.data_start + if version == 0 { 4 } else { 6 };
        for _ in 0..count.min(64) {
            let to = if version == 0 {
                s.u16(p).map(u32::from)
            } else {
                s.u32(p)
            };
            p += if version == 0 { 2 } else { 4 };
            let Some(to) = to else { break };
            out.refs.push(ItemRef {
                ref_type: r.typ,
                from,
                to,
            });
        }
    }
}

fn read_cstr(s: &Sparse, from: u64, limit: u64) -> (String, u64) {
    let max = (limit - from).min(256) as usize;
    let mut buf = Vec::with_capacity(max.min(64));
    let mut p = from;
    while p < from + max as u64 {
        match s.byte(p) {
            Some(0) => {
                p += 1;
                break;
            }
            Some(b) => {
                buf.push(b);
                p += 1;
            }
            None => break,
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), p)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bits::Sparse;

    pub fn boxed(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(body.len() + 8);
        v.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    fn infe_v2(id: u16, typ: &[u8; 4], name: &str) -> Vec<u8> {
        let mut body = vec![2, 0, 0, 0];
        body.extend_from_slice(&id.to_be_bytes());
        body.extend_from_slice(&0u16.to_be_bytes());
        body.extend_from_slice(typ);
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        boxed(b"infe", &body)
    }

    /// A HEIC whose `iloc` places a video item at `video_off` and the primary
    /// image at 0.
    pub fn synth_heic(video_off: u64, video_len: u64) -> Vec<u8> {
        let mut iinf_body = vec![0u8, 0, 0, 0];
        iinf_body.extend_from_slice(&2u16.to_be_bytes());
        iinf_body.extend_from_slice(&infe_v2(1, b"hvc1", "Primary"));
        iinf_body.extend_from_slice(&infe_v2(2, b"hvc1", "MotionPhoto"));
        let iinf = boxed(b"iinf", &iinf_body);

        let mut pitm_body = vec![0u8, 0, 0, 0];
        pitm_body.extend_from_slice(&1u16.to_be_bytes());
        let pitm = boxed(b"pitm", &pitm_body);

        // iloc v0, offset_size=4, length_size=4, base_offset_size=0
        let mut iloc_body = vec![0u8, 0, 0, 0, 0x44, 0x00];
        iloc_body.extend_from_slice(&2u16.to_be_bytes());
        for (id, off, len) in [
            (1u16, 0u32, 0u32),
            (2u16, video_off as u32, video_len as u32),
        ] {
            iloc_body.extend_from_slice(&id.to_be_bytes());
            iloc_body.extend_from_slice(&0u16.to_be_bytes());
            iloc_body.extend_from_slice(&1u16.to_be_bytes());
            iloc_body.extend_from_slice(&off.to_be_bytes());
            iloc_body.extend_from_slice(&len.to_be_bytes());
        }
        let iloc = boxed(b"iloc", &iloc_body);

        // iref: cdsc from item 1 to item 2. `cdsc` is a plain Box (the version
        // and flags live on the enclosing `iref`), so the body starts directly
        // with the source item id.
        let mut cdsc_body = Vec::new();
        cdsc_body.extend_from_slice(&1u16.to_be_bytes());
        cdsc_body.extend_from_slice(&1u16.to_be_bytes());
        cdsc_body.extend_from_slice(&2u16.to_be_bytes());
        let iref = boxed(
            b"iref",
            &[vec![0u8, 0, 0, 0], boxed(b"cdsc", &cdsc_body)].concat(),
        );

        // iprp/ipco with an ispe property
        let mut ispe_body = vec![0u8, 0, 0, 0];
        ispe_body.extend_from_slice(&4032u32.to_be_bytes());
        ispe_body.extend_from_slice(&3024u32.to_be_bytes());
        let ipco = boxed(b"ipco", &boxed(b"ispe", &ispe_body));
        let iprp = boxed(b"iprp", &ipco);

        let mut meta_body = vec![0u8, 0, 0, 0];
        meta_body.extend_from_slice(&pitm);
        meta_body.extend_from_slice(&iinf);
        meta_body.extend_from_slice(&iloc);
        meta_body.extend_from_slice(&iref);
        meta_body.extend_from_slice(&iprp);
        let meta = boxed(b"meta", &meta_body);

        let ftyp = crate::mp4::build_ftyp(b"heic", &[*b"heic", *b"mif1"]);
        let mut out = ftyp;
        out.extend_from_slice(&meta);
        out.resize(video_off as usize, 0);
        out.resize((video_off + video_len) as usize, 0x5a);
        out
    }

    #[test]
    fn finds_video_item_by_type() {
        let data = synth_heic(2048, 4096);
        let mut s = Sparse::new();
        s.add(&data, 0);
        assert!(is_isobmff(&s));
        assert_eq!(major_brand(&s).as_ref(), Some(b"heic"));
        assert!(is_heif_brand(&major_brand(&s).unwrap()));
        let meta = find_meta(&s, data.len() as u64).expect("meta");
        let parsed = parse_meta(&s, &meta).expect("parse");
        assert_eq!(parsed.primary, Some(1));
        assert_eq!(parsed.items.len(), 2);
        assert_eq!(parsed.width, Some(4032));
        assert_eq!(parsed.described_by_primary(), vec![2]);
        let v = parsed.video_item().expect("video item");
        assert_eq!(v.id, 2);
        assert_eq!(v.name, "MotionPhoto");
        assert_eq!(v.type_str(), "hvc1");
        assert_eq!(v.start(), Some(2048));
        assert_eq!(v.total_len(), 4096);
        assert!(v.contiguous());
        assert!(v.is_video());
    }

    #[test]
    fn does_not_pick_the_primary_item_as_video() {
        // A file where the primary image is also hvc1: only the described item
        // may win.
        let data = synth_heic(3072, 1024);
        let mut s = Sparse::new();
        s.add(&data, 0);
        let meta = parse_meta(&s, &find_meta(&s, data.len() as u64).unwrap()).unwrap();
        assert_ne!(meta.video_item().unwrap().id, meta.primary.unwrap());
    }

    #[test]
    fn meta_parses_when_windows_are_partial() {
        // Only the head is available: items and dimensions must still resolve,
        // because detection must not depend on reading the media bytes.
        let data = synth_heic(200_000, 400_000);
        let mut s = Sparse::new();
        s.add(&data[..8192], 0);
        s.add(&data[data.len() - 4096..], (data.len() - 4096) as u64);
        let meta = parse_meta(&s, &find_meta(&s, data.len() as u64).unwrap()).unwrap();
        let v = meta.video_item().unwrap();
        assert_eq!(v.start(), Some(200_000));
        assert_eq!(v.total_len(), 400_000);
    }
}
