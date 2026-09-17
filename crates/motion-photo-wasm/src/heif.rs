//! HEIF/HEIC/AVIF `meta` box reading.
//!
//! Android's Motion Photo 1.0 format stores the video of an ISOBMFF still as an
//! *item*: a second payload described by `iloc`, tied to the primary image item
//! by an item reference. Reading `meta` is therefore enough to name the exact
//! byte range of the video without scanning the file, which is precisely what a
//! no-copy extractor wants.

use crate::bits::{boxes, child, BoxHdr, Sparse};

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

    /// True when the item's own metadata says "video", and only then.
    ///
    /// The subtlety that matters: `hvc1`, `hev1`, `av01`, `vp08` and `vp09` are
    /// the *image* codecs of HEIC and AVIF, so the tiles of an ordinary phone
    /// photo carry exactly the item types a naive test would call video. That
    /// mistaken test makes every plain HEIC look like a motion photo. The
    /// unambiguous signals are a `mime` item whose content type is a video, or a
    /// codec that cannot be a HEIF still image.
    pub fn is_video(&self) -> bool {
        if self.item_type == *b"mime" {
            return self.content_type.starts_with("video/");
        }
        self.content_type.starts_with("video/")
            || matches!(&self.item_type, b"avc1" | b"avc3" | b"mp4v" | b"encv")
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
    width_height: Option<(u32, u32)>,
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
    ///
    /// An item has to *be* a video to qualify; the `cdsc` reference and the item
    /// size only decide between candidates. Grid tiles are excluded outright:
    /// the primary grid references them with `dimg`, which by definition makes
    /// them pictures.
    pub fn video_item(&self) -> Option<&Item> {
        let described = self.described_by_primary();
        let tiles: Vec<u32> = self
            .refs
            .iter()
            .filter(|r| &r.ref_type == b"dimg")
            .map(|r| r.to)
            .collect();
        let mut best: Option<&Item> = None;
        let mut best_rank: (u8, u64) = (0, 0);
        for item in &self.items {
            if Some(item.id) == self.primary || tiles.contains(&item.id) {
                continue;
            }
            if !item.is_video() || item.extents.is_empty() || item.in_idat {
                continue;
            }
            let rank = ((described.contains(&item.id) as u8) * 2, item.total_len());
            if best.is_none() || rank > best_rank {
                best_rank = rank;
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
        // Dimensions come from the *primary* item's `ispe`, resolved through
        // `ipma`. Taking the first `ispe` in the property list gives a tile's
        // size instead: an iPhone HEIC of 1402x1363 is a grid of 512x512 tiles,
        // and reporting 512x512 is simply wrong.
        let ipco = child(s, &iprp, b"ipco");
        if let Some(ipco) = &ipco {
            let properties: Vec<BoxHdr> = boxes(s, ipco.data_start, ipco.data_end).collect();
            let mut associated = None;
            if let (Some(primary), Some(ipma)) = (out.primary, child(s, &iprp, b"ipma")) {
                associated = ipma_ispe(s, &ipma, primary, &properties);
            }
            out.width_height = associated.or_else(|| largest_ispe(s, &properties));
        }
    }
    if let Some((w, h)) = out.width_height {
        out.width = Some(w);
        out.height = Some(h);
    } else {
        out.width = None;
        out.height = None;
    }
    Some(out)
}

/// The `ispe` associated with `primary` through `ipma`, when it can be found.
///
/// `ipma` maps items to indices in the ordered `ipco` property list; the width
/// of an index field depends on the version and on the flags' low bit.
fn ipma_ispe(s: &Sparse, ipma: &BoxHdr, primary: u32, properties: &[BoxHdr]) -> Option<(u32, u32)> {
    let version = s.byte(ipma.data_start)?;
    let flags = s.read(ipma.data_start + 1, 3)?;
    let wide_index = flags[2] & 1 == 1;
    let count = s.u32(ipma.data_start + 4)?;
    let mut p = ipma.data_start + 8;
    for _ in 0..count.min(512) {
        let id = if version < 1 {
            let v = s.u16(p)?;
            p += 2;
            v as u32
        } else {
            let v = s.u32(p)?;
            p += 4;
            v
        };
        let associations = s.byte(p)? as usize;
        p += 1;
        let mut found = None;
        for _ in 0..associations.min(64) {
            let index: u32 = if wide_index {
                let v = (s.u16(p)? & 0x7fff) as u32;
                p += 2;
                v
            } else {
                let v = (s.byte(p)? & 0x7f) as u32;
                p += 1;
                v
            };
            if id == primary {
                found = Some(index as usize);
            }
        }
        if let Some(index) = found {
            let property = properties.get(index.checked_sub(1)?)?;
            if property.is(b"ispe") {
                return ispe_size(s, property);
            }
        }
    }
    None
}

/// The largest `ispe` in the property list: a fallback for files whose `ipma`
/// cannot be read, and the right answer whenever tiles are smaller than the
/// picture they compose.
fn largest_ispe(s: &Sparse, properties: &[BoxHdr]) -> Option<(u32, u32)> {
    properties
        .iter()
        .filter(|p| p.is(b"ispe"))
        .filter_map(|p| ispe_size(s, p))
        .max_by_key(|(w, h)| (*w as u64) * (*h as u64))
}

fn ispe_size(s: &Sparse, ispe: &BoxHdr) -> Option<(u32, u32)> {
    // FullBox: version/flags, then width and height.
    let w = s.u32(ispe.data_start + 4)?;
    let h = s.u32(ispe.data_start + 8)?;
    if w == 0 || h == 0 || w > 1_000_000 || h > 1_000_000 {
        return None;
    }
    Some((w, h))
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
        infe_v2_typed(id, typ, name, None)
    }

    fn infe_v2_typed(id: u16, typ: &[u8; 4], name: &str, content_type: Option<&str>) -> Vec<u8> {
        let mut body = vec![2, 0, 0, 0];
        body.extend_from_slice(&id.to_be_bytes());
        body.extend_from_slice(&0u16.to_be_bytes());
        body.extend_from_slice(typ);
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        if let Some(ct) = content_type {
            body.extend_from_slice(ct.as_bytes());
            body.push(0);
        }
        boxed(b"infe", &body)
    }

    /// A HEIC whose `iloc` places a video item at `video_off` and the primary
    /// image at 0.
    pub fn synth_heic(video_off: u64, video_len: u64) -> Vec<u8> {
        let mut iinf_body = vec![0u8, 0, 0, 0];
        iinf_body.extend_from_slice(&2u16.to_be_bytes());
        iinf_body.extend_from_slice(&infe_v2(1, b"hvc1", "Primary"));
        // A video item is marked the way the specification marks one: a `mime`
        // item whose content type is a video. `hvc1` alone would be an image.
        iinf_body.extend_from_slice(&infe_v2_typed(2, b"mime", "MotionPhoto", Some("video/mp4")));
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
        assert_eq!(v.type_str(), "mime");
        assert_eq!(v.content_type, "video/mp4");
        assert_eq!(v.start(), Some(2048));
        assert_eq!(v.total_len(), 4096);
        assert!(v.contiguous());
        assert!(v.is_video());
    }

    /// The tiles of an ordinary HEIC are `hvc1` items with extents - exactly
    /// what a naive "is it a video codec" test would accept. Only the ones the
    /// primary grid references with `dimg` may be excluded.
    #[test]
    fn a_plain_heic_yields_no_video_item() {
        let data = synth_plain_heic();
        let mut s = Sparse::new();
        s.add(&data, 0);
        let meta = parse_meta(&s, &find_meta(&s, data.len() as u64).unwrap()).unwrap();
        assert!(meta.items.len() >= 4, "tiles and metadata items are parsed");
        assert!(
            meta.items
                .iter()
                .any(|i| i.item_type == *b"hvc1" && !i.extents.is_empty()),
            "the fixture really does contain HEVC image tiles"
        );
        assert!(
            meta.video_item().is_none(),
            "an image tile must never be a video item"
        );
    }

    /// ftyp | meta(pitm=grid, tiles=2, Exif) | mdat[tiles, exif], with the grid
    /// referencing its tiles through `dimg`.
    fn synth_plain_heic() -> Vec<u8> {
        let tile = vec![0x5au8; 256];
        let mut iinf_body = vec![0u8, 0, 0, 0];
        iinf_body.extend_from_slice(&4u16.to_be_bytes());
        iinf_body.extend_from_slice(&infe_v2(1, b"grid", ""));
        iinf_body.extend_from_slice(&infe_v2(2, b"hvc1", ""));
        iinf_body.extend_from_slice(&infe_v2(3, b"hvc1", ""));
        iinf_body.extend_from_slice(&infe_v2(4, b"Exif", ""));

        let mut pitm_body = vec![0u8, 0, 0, 0];
        pitm_body.extend_from_slice(&1u16.to_be_bytes());

        let mut iloc_body = vec![0u8, 0, 0, 0, 0x44, 0x00];
        iloc_body.extend_from_slice(&4u16.to_be_bytes());
        for (id, off, len) in [(1u16, 0u32, 8u32), (2, 0, 256), (3, 256, 256), (4, 512, 16)] {
            iloc_body.extend_from_slice(&id.to_be_bytes());
            iloc_body.extend_from_slice(&0u16.to_be_bytes());
            iloc_body.extend_from_slice(&1u16.to_be_bytes());
            iloc_body.extend_from_slice(&off.to_be_bytes());
            iloc_body.extend_from_slice(&len.to_be_bytes());
        }

        let mut dimg_body = vec![0u8, 0, 0, 0];
        dimg_body.extend_from_slice(&1u16.to_be_bytes());
        dimg_body.extend_from_slice(&2u16.to_be_bytes());
        dimg_body.extend_from_slice(&2u16.to_be_bytes());
        dimg_body.extend_from_slice(&3u16.to_be_bytes());

        let mut meta_body = vec![0u8, 0, 0, 0];
        meta_body.extend_from_slice(&boxed(b"pitm", &pitm_body));
        meta_body.extend_from_slice(&boxed(b"iinf", &iinf_body));
        meta_body.extend_from_slice(&boxed(b"iloc", &iloc_body));
        meta_body.extend_from_slice(&boxed(b"iref", &boxed(b"dimg", &dimg_body)));

        let mut out = crate::mp4::build_ftyp(b"heic", &[*b"heic", *b"mif1"]);
        out.extend_from_slice(&boxed(b"meta", &meta_body));
        out.extend_from_slice(&boxed(
            b"mdat",
            &[tile.as_slice(), tile.as_slice(), &[0x22u8; 16]].concat(),
        ));
        out
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
