//! XMP scanning for the Motion Photo 1.0 container directory and its older
//! relatives.
//!
//! A full XML parser would be both heavy and unnecessary: every property this
//! crate needs is a leaf with a short literal value, and the container
//! directory is a flat list of `Container:Item` elements. The scanner below
//! accepts both the RDF attribute form that Android and Samsung actually write
//! and the element form, tolerates arbitrary namespace prefixes, and is bounded
//! in both time and result size.

use crate::bits::{find_sub, FindAll};

/// One entry of `Container:Directory`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ContainerItem {
    pub mime: Option<String>,
    pub semantic: Option<String>,
    pub length: Option<u64>,
    pub padding: Option<u64>,
}

impl ContainerItem {
    /// Bytes this item occupies at the end of the file.
    pub fn stored_len(&self) -> u64 {
        self.length.unwrap_or(0) + self.padding.unwrap_or(0)
    }

    /// A motion photo video item: a video MIME type, and a semantic that does
    /// not say otherwise. `GainMap` items are images and are never eligible.
    pub fn is_video(&self) -> bool {
        let mime_ok = match self.mime.as_deref() {
            Some(m) => m.starts_with("video/"),
            None => false,
        };
        let semantic_ok = match self.semantic.as_deref() {
            None => true,
            Some(s) => s.eq_ignore_ascii_case("MotionPhoto") || s.eq_ignore_ascii_case("Primary"),
        };
        mime_ok && semantic_ok
    }

    pub fn is_gain_map(&self) -> bool {
        self.semantic
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("GainMap"))
            .unwrap_or(false)
    }

    pub fn is_image(&self) -> bool {
        match self.mime.as_deref() {
            Some(m) => m.starts_with("image/"),
            None => false,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Xmp {
    pub present: bool,
    pub motion_photo: Option<bool>,
    pub motion_photo_version: Option<u64>,
    pub presentation_timestamp_us: Option<i64>,
    pub micro_video: Option<bool>,
    pub micro_video_offset: Option<u64>,
    pub micro_video_timestamp_us: Option<i64>,
    pub directory: Vec<ContainerItem>,
    /// `EmbeddedVideoType` values that appear verbatim in the file. Samsung
    /// stores `MotionPhoto_Data` in its maker notes; seeing the literal string
    /// is cheap evidence that this is a Samsung motion photo.
    pub samsung_markers: Vec<String>,
    pub google_markers: Vec<String>,
}

const SAMSUNG_MARKERS: [&str; 4] = [
    "MotionPhoto_Data",
    "EmbeddedVideoFile",
    "EmbeddedVideoType",
    "MotionPhoto_Data_",
];
const GOOGLE_MARKERS: [&str; 3] = ["MotionPhoto", "MicroVideo", "Camera:MotionPhoto"];

/// Scans a head window. `head` must be the bytes starting at file offset 0.
pub fn scan_head(head: &[u8]) -> Xmp {
    let mut out = Xmp::default();
    if head.is_empty() {
        return out;
    }
    if find_sub(head, b"http://ns.adobe.com/xap/1.0/").is_some()
        || find_sub(head, b"MotionPhoto").is_some()
        || find_sub(head, b"MicroVideo").is_some()
    {
        out.present = true;
    }

    // Namespace prefixes vary between writers (Camera:, GCamera:, or none), so
    // match the local name at a token boundary.
    if let Some(v) = find_flag(head, "MotionPhoto") {
        out.motion_photo = Some(v);
    }
    if let Some(v) = find_uint(head, "MotionPhotoVersion") {
        out.motion_photo_version = Some(v);
    }
    if let Some(v) = find_int(head, "MotionPhotoPresentationTimestampUs") {
        out.presentation_timestamp_us = Some(v);
    }
    if let Some(v) = find_flag(head, "MicroVideo") {
        out.micro_video = Some(v);
    }
    if let Some(v) = find_uint(head, "MicroVideoOffset") {
        out.micro_video_offset = Some(v);
    }
    if let Some(v) = find_int(head, "MicroVideoPresentationTimestampUs") {
        out.micro_video_timestamp_us = Some(v);
    }

    out.directory = parse_directory(head);

    for m in SAMSUNG_MARKERS {
        if find_sub(head, m.as_bytes()).is_some() {
            out.samsung_markers.push(m.to_string());
        }
    }
    for m in GOOGLE_MARKERS {
        if find_sub(head, m.as_bytes()).is_some() {
            out.google_markers.push(m.to_string());
        }
    }
    out
}

/// Extracts the items of `Container:Directory`, in document order.
///
/// Handles the current `Container:Item` form, the legacy `GContainerItem` form
/// that AOSP also accepts, and the element form. The directory is a flat list of
/// short elements, so a bounded scan for the item attributes is both sufficient
/// and cheaper than an XML parser.
pub fn parse_directory(head: &[u8]) -> Vec<ContainerItem> {
    const DIRECTORY_WINDOW: usize = 8192;
    const MAX_ITEMS: usize = 32;

    let Some(at) = find_sub(head, b"Container:Directory").or_else(|| find_sub(head, b":Directory"))
    else {
        return Vec::new();
    };
    let end = (at + DIRECTORY_WINDOW).min(head.len());
    let region = &head[at..end];

    // Split the region into elements and keep the ones that carry item
    // attributes. Wrapper elements (`rdf:li`, `rdf:Seq`) carry none.
    let mut items = Vec::new();
    for pos in FindAll::new(region, b"<", MAX_ITEMS * 4) {
        if items.len() >= MAX_ITEMS {
            break;
        }
        let rest = &region[pos + 1..];
        let tag_end = rest
            .iter()
            .position(|&b| b == b'>')
            .map(|i| pos + 1 + i)
            .unwrap_or_else(|| region.len().min(pos + 512));
        let element_end = (tag_end + 512).min(region.len());
        let tag = &region[pos + 1..tag_end];
        let element = &region[pos + 1..element_end];
        let item = ContainerItem {
            mime: attr(tag, element, "Mime"),
            semantic: attr(tag, element, "Semantic"),
            length: attr(tag, element, "Length").and_then(|v| parse_u64(&v)),
            padding: attr(tag, element, "Padding").and_then(|v| parse_u64(&v)),
        };
        if item.mime.is_some() || item.semantic.is_some() || item.length.is_some() {
            items.push(item);
        }
    }
    items
}

/// Reads `Name="value"`, `Name='value'` from a tag, or `<Name>value</Name>`
/// from the element body.
fn attr(tag: &[u8], element: &[u8], name: &str) -> Option<String> {
    // The directory items use a `Item:` prefix; accept a bare name too.
    for prefix in ["Item:", ""] {
        let mut key = String::with_capacity(prefix.len() + name.len());
        key.push_str(prefix);
        key.push_str(name);
        if let Some(v) = attr_exact(tag, key.as_bytes()) {
            return Some(v);
        }
        // Element form: <Item:Length>1234</Item:Length>
        let mut open = String::with_capacity(key.len() + 2);
        open.push('<');
        open.push_str(&key);
        open.push('>');
        if let Some(i) = find_sub(element, open.as_bytes()) {
            let start = i + open.len();
            let rest = &element[start..];
            if let Some(stop) = rest.iter().position(|&b| b == b'<') {
                return Some(trim_ascii(&rest[..stop]));
            }
        }
    }
    None
}

/// Finds `name` as a whole attribute name inside a tag and returns its value.
fn attr_exact(tag: &[u8], name: &[u8]) -> Option<String> {
    let mut from = 0usize;
    while let Some(rel) = find_sub(&tag[from..], name) {
        let at = from + rel;
        from = at + 1;
        // Must be preceded by a boundary (start, whitespace, `<`, or `:`).
        let before_ok =
            at == 0 || matches!(tag[at - 1], b' ' | b'\t' | b'\n' | b'\r' | b'<' | b':');
        if !before_ok {
            continue;
        }
        let after = at + name.len();
        // Must be followed by `=`, whitespace, `>`, or `/` - never `(` or an
        // alphanumeric, which would mean we matched a longer name.
        if after >= tag.len() {
            return None;
        }
        let mut p = after;
        while p < tag.len() && matches!(tag[p], b' ' | b'\t' | b'\n' | b'\r') {
            p += 1;
        }
        if p >= tag.len() {
            return None;
        }
        if tag[p] != b'=' {
            // Attribute present without `=` (e.g. rdf:parseType style); not what
            // we are looking for.
            continue;
        }
        p += 1;
        while p < tag.len() && matches!(tag[p], b' ' | b'\t' | b'\n' | b'\r') {
            p += 1;
        }
        if p >= tag.len() {
            return None;
        }
        let quote = tag[p];
        if quote == b'"' || quote == b'\'' {
            p += 1;
            let rest = &tag[p..];
            let stop = rest.iter().position(|&b| b == quote)?;
            return Some(trim_ascii(&rest[..stop]));
        }
        // Unquoted value: read to whitespace or `>`.
        let rest = &tag[p..];
        let stop = rest
            .iter()
            .position(|&b| matches!(b, b' ' | b'\t' | b'>' | b'/'))
            .unwrap_or(rest.len());
        return Some(trim_ascii(&rest[..stop]));
    }
    None
}

/// Finds a boolean-ish property anywhere in the packet.
fn find_flag(head: &[u8], name: &str) -> Option<bool> {
    let v = find_property(head, name)?;
    match v.as_str() {
        "1" | "true" | "True" | "TRUE" | "yes" => Some(true),
        "0" | "false" | "False" | "FALSE" | "no" => Some(false),
        _ => None,
    }
}

fn find_int(head: &[u8], name: &str) -> Option<i64> {
    let v = find_property(head, name)?;
    parse_i64(&v)
}

fn find_uint(head: &[u8], name: &str) -> Option<u64> {
    let v = find_property(head, name)?;
    parse_u64(&v)
}

/// Finds a property by local name, tolerating any namespace prefix.
fn find_property(head: &[u8], name: &str) -> Option<String> {
    let needle = name.as_bytes();
    for at in FindAll::new(head, needle, 64) {
        let before_ok =
            at == 0 || matches!(head[at - 1], b' ' | b'\t' | b'\n' | b'\r' | b'<' | b':');
        if !before_ok {
            continue;
        }
        let after = at + needle.len();
        if after > head.len() {
            continue;
        }
        // Build a synthetic tag slice: attributes end at the element close.
        let tag_end = head[after..]
            .iter()
            .position(|&b| b == b'>')
            .map(|i| after + i)
            .unwrap_or(head.len());
        // `MotionPhotoVersion` must not satisfy `MotionPhoto`, hence the check
        // that the next byte is not a name character.
        let next = head.get(after).copied().unwrap_or(b'>');
        if next.is_ascii_alphanumeric() || next == b'_' || next == b'-' {
            continue;
        }
        let tag = &head[at..tag_end];
        if let Some(v) = attr_exact(tag, needle) {
            return Some(v);
        }
        // Element form: <Camera:MotionPhoto>1</Camera:MotionPhoto>
        if next == b'>' {
            let rest = &head[after + 1..];
            if let Some(stop) = rest.iter().position(|&b| b == b'<') {
                let v = trim_ascii(&rest[..stop]);
                if !v.is_empty() && v.len() < 128 {
                    return Some(v);
                }
            }
        }
        // Attribute may sit behind `rdf:parseType` style noise.
        let scan_end = (after + 256).min(head.len());
        let region = &head[at..scan_end];
        if let Some(v) = attr_exact(region, needle) {
            return Some(v);
        }
    }
    None
}

fn trim_ascii(b: &[u8]) -> String {
    let start = b
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(b.len());
    let end = b
        .iter()
        .rposition(|c| !c.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    String::from_utf8_lossy(&b[start..end]).into_owned()
}

pub fn parse_u64(s: &str) -> Option<u64> {
    let t = s.trim();
    if t.is_empty() || t.len() > 20 {
        return None;
    }
    let mut v: u64 = 0;
    for c in t.bytes() {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v.checked_mul(10)?.checked_add((c - b'0') as u64)?;
    }
    Some(v)
}

pub fn parse_i64(s: &str) -> Option<i64> {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix('-') {
        parse_u64(rest).and_then(|v| {
            if v <= i64::MAX as u64 + 1 {
                Some(-(v as i64))
            } else {
                None
            }
        })
    } else {
        parse_u64(t).and_then(|v| i64::try_from(v).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOGLE_XMP: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    Camera:MotionPhoto="1"
    Camera:MotionPhotoVersion="1"
    Camera:MotionPhotoPresentationTimestampUs="1250000">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="42000" Item:Padding="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="1800000" Item:Padding="0"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;

    #[test]
    fn parses_google_motion_photo_1_0() {
        let x = scan_head(GOOGLE_XMP.as_bytes());
        assert!(x.present);
        assert_eq!(x.motion_photo, Some(true));
        assert_eq!(x.motion_photo_version, Some(1));
        assert_eq!(x.presentation_timestamp_us, Some(1_250_000));
        assert_eq!(x.directory.len(), 2);
        assert_eq!(x.directory[0].mime.as_deref(), Some("image/jpeg"));
        assert_eq!(x.directory[0].semantic.as_deref(), Some("Primary"));
        assert_eq!(x.directory[0].length, Some(42000));
        assert!(x.directory[0].is_image());
        assert_eq!(x.directory[1].mime.as_deref(), Some("video/mp4"));
        assert_eq!(x.directory[1].semantic.as_deref(), Some("MotionPhoto"));
        assert_eq!(x.directory[1].length, Some(1_800_000));
        assert!(x.directory[1].is_video());
        assert_eq!(x.directory[1].stored_len(), 1_800_000);
    }

    #[test]
    fn distinct_properties_do_not_confuse_each_other() {
        // `MotionPhotoVersion` must not be read as `MotionPhoto`, and vice versa.
        let x = scan_head(GOOGLE_XMP.as_bytes());
        assert_eq!(x.motion_photo, Some(true));
        assert_eq!(x.motion_photo_version, Some(1));
    }

    #[test]
    fn parses_old_microvideo_form() {
        let xmp = br#"<rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
            GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1"
            GCamera:MicroVideoOffset="998877"
            GCamera:MicroVideoPresentationTimestampUs="900000"/>"#;
        let x = scan_head(xmp);
        assert_eq!(x.micro_video, Some(true));
        assert_eq!(x.micro_video_offset, Some(998877));
        assert_eq!(x.micro_video_timestamp_us, Some(900000));
    }

    #[test]
    fn tolerates_element_form_and_odd_prefixes() {
        let xmp = br#"<nonsense:Foo><MotionPhoto>1</MotionPhoto>
            <x:MotionPhotoPresentationTimestampUs>250000</x:MotionPhotoPresentationTimestampUs>
            <ItemContainer:Directory><Container:Item Item:Mime='video/mp4' Item:Length='77'/></ItemContainer:Directory></nonsense:Foo>"#;
        let x = scan_head(xmp);
        assert_eq!(x.motion_photo, Some(true));
        assert_eq!(x.presentation_timestamp_us, Some(250000));
        assert_eq!(x.directory.len(), 1);
        assert_eq!(x.directory[0].length, Some(77));
    }

    #[test]
    fn detects_samsung_markers() {
        let samsung = b"...maker note... MotionPhoto_Data ... EmbeddedVideoType ...";
        let x = scan_head(samsung);
        assert!(x.samsung_markers.iter().any(|m| m == "MotionPhoto_Data"));
    }

    #[test]
    fn hostile_input_stays_bounded() {
        let mut junk = vec![b'x'; 200_000];
        junk.extend_from_slice(b"Container:Directory");
        junk.extend(std::iter::repeat(b'<').take(100_000));
        let x = scan_head(&junk);
        assert!(x.directory.len() <= 32);
    }

    #[test]
    fn integer_parsing_rejects_junk() {
        assert_eq!(parse_u64("1234"), Some(1234));
        assert_eq!(parse_u64(""), None);
        assert_eq!(parse_u64("12a"), None);
        assert_eq!(parse_u64("99999999999999999999999"), None);
        assert_eq!(parse_i64("-5"), Some(-5));
        assert_eq!(parse_i64("+5"), None);
    }
}
