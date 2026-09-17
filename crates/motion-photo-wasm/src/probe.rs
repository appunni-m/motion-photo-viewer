//! Detection and extraction planning.
//!
//! The contract with JavaScript is a JSON *plan*: a list of literal byte strings
//! (a synthesized `ftyp`, a patched `moov`, an `mdat` header) plus a list of
//! absolute file ranges. JavaScript concatenates them into a `Blob` and hands
//! the blob URL to a `<video>` element. The media bytes are therefore never
//! copied into WebAssembly memory, never base64'd, and never stored anywhere.
//!
//! Three detection routes, cheapest first:
//!
//! 1. **Metadata route** - XMP `Container:Directory` (Google Motion Photo 1.0)
//!    or a HEIF item (`iloc` + `cdsc`). Gives the exact video range.
//! 2. **Container route** - if the range is already a complete MP4, the plan is
//!    a single slice and nothing is rebuilt.
//! 3. **Sample-table route** - otherwise the `moov` (a few KiB, always at one
//!    end of a motion photo payload) is rewritten with corrected chunk offsets
//!    and the media span is copied verbatim. This is what rescues Samsung files
//!    whose container start is neither in the head nor the tail window.

use crate::bits::{boxes, read_box, Sparse};
use crate::exif::{self, Exif};
use crate::heif;
use crate::jpeg;
use crate::json::{base64_encode, J};
use crate::mp4::{self, Moov};
use crate::seft;
use crate::xmp::{self, Xmp};

/// A JPEG is never this small, so a claimed still length below it is a sign the
/// metadata is wrong and is ignored rather than handed to a decoder.
pub const MIN_STILL_BYTES: u64 = 128;
/// Absolute ceiling for any single window the driver may be asked to read.
pub const HARD_SCAN_LIMIT: u64 = 8 * 1024 * 1024;
/// Window sizes the driver mirrors (see `src/worker.js`). They live here as
/// documentation of what detection is designed around, and as the ceiling the
/// core will ask for when it needs more.
pub const HEAD_WINDOW: u64 = 64 * 1024;
/// Ceiling for growing the head window to finish a HEIF item table.
pub const HEAD_WINDOW_MAX: u64 = 1024 * 1024;
/// The first tail window tries to cover a trailer `moov` or SEFT directory.
pub const TAIL_WINDOW: u64 = 64 * 1024;
pub const TAIL_WINDOW_MAX: u64 = 2 * 1024 * 1024;
/// Window requested at the start of a candidate video range.
pub const REGION_WINDOW: u64 = 192 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    /// Bytes synthesized by this crate.
    Literal(Vec<u8>),
    /// A verbatim `File.slice()` range of the original file.
    Slice { off: u64, len: u64 },
}

#[derive(Clone, Debug, Default)]
pub struct VideoPlan {
    pub parts: Vec<Part>,
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    /// True when the plan is a single verbatim slice of a valid MP4.
    pub direct: bool,
}

#[derive(Clone, Debug)]
pub enum ReadMore {
    Head {
        bytes: u64,
        reason: &'static str,
    },
    Tail {
        bytes: u64,
        reason: &'static str,
    },
    /// Read at the start of a candidate video range, then call `prepare`.
    Window {
        off: u64,
        bytes: u64,
        region: (u64, u64),
        reason: &'static str,
    },
}

#[derive(Clone, Debug)]
pub struct Outcome {
    pub container: &'static str,
    pub still_mime: Option<&'static str>,
    pub file_size: u64,
    pub family: Option<&'static str>,
    pub method: Option<&'static str>,
    pub confidence: &'static str,
    pub video: Option<(u64, u64)>,
    pub still_len: Option<u64>,
    pub plan: Option<VideoPlan>,
    pub playable: bool,
    pub reason: Option<String>,
    pub read_more: Option<ReadMore>,
    pub timestamp_us: Option<i64>,
    pub meta: Exif,
    pub markers: Vec<String>,
    pub notes: Vec<String>,
    /// True for a plain video file that is not a motion photo at all.
    pub plain_video: bool,
    /// Set when the file is a still without any embedded motion.
    pub kind: &'static str,
    /// Top-level box types seen in the windows, for the diagnostics panel.
    pub boxes: Vec<String>,
}

impl Default for Outcome {
    fn default() -> Self {
        Outcome {
            container: "unknown",
            still_mime: None,
            file_size: 0,
            family: None,
            method: None,
            confidence: "none",
            video: None,
            still_len: None,
            plan: None,
            playable: false,
            reason: None,
            read_more: None,
            timestamp_us: None,
            meta: Exif::default(),
            markers: Vec::new(),
            notes: Vec::new(),
            plain_video: false,
            kind: "unknown",
            boxes: Vec::new(),
        }
    }
}

impl Outcome {
    pub fn note(&mut self, s: impl Into<String>) {
        if self.notes.len() < 12 {
            self.notes.push(s.into());
        }
    }

    pub fn to_json(&self) -> String {
        let mut j = J::new();
        j.begin_obj();
        j.key_bool("ok", true);
        j.key_str("kind", self.kind);
        j.key_str("container", self.container);
        j.key_u64("fileSize", self.file_size);

        j.key("still");
        if self.still_mime.is_some() || self.meta != Exif::default() {
            j.begin_obj();
            match self.still_mime {
                Some(m) => j.key_str("mime", m),
                None => j.key_null("mime"),
            }
            match self.meta.width {
                Some(w) => j.key_u64("width", w as u64),
                None => j.key_null("width"),
            }
            match self.meta.height {
                Some(h) => j.key_u64("height", h as u64),
                None => j.key_null("height"),
            }
            match self.still_len {
                Some(l) => j.key_u64("length", l),
                None => j.key_null("length"),
            }
            j.key("thumb");
            match self.meta.thumb {
                Some((off, len)) => {
                    j.begin_obj();
                    j.key_u64("off", off);
                    j.key_u64("len", len);
                    match self.meta.thumb_orientation {
                        Some(o) => j.key_u64("orientation", o as u64),
                        None => j.key_null("orientation"),
                    }
                    j.end();
                }
                None => j.null(),
            }
            j.end();
        } else {
            j.null();
        }

        j.key("motion");
        if self.video.is_some() || self.family.is_some() || self.plan.is_some() {
            j.begin_obj();
            j.key_bool("found", self.video.is_some() || self.plan.is_some());
            match self.family {
                Some(f) => j.key_str("family", f),
                None => j.key_null("family"),
            }
            match self.method {
                Some(m) => j.key_str("method", m),
                None => j.key_null("method"),
            }
            j.key_str("confidence", self.confidence);
            j.key("video");
            match self.video {
                Some((off, len)) => {
                    j.begin_obj();
                    j.key_u64("off", off);
                    j.key_u64("len", len);
                    j.end();
                }
                None => j.null(),
            }
            match self.timestamp_us {
                Some(t) => j.key_i64("timestampUs", t),
                None => j.key_null("timestampUs"),
            }
            j.key_bool("playable", self.playable);
            match self.plan.as_ref().and_then(|p| p.codec.clone()) {
                Some(c) => j.key_str("codec", &c),
                None => j.key_null("codec"),
            }
            match self.plan.as_ref().and_then(|p| p.width) {
                Some(w) => j.key_u64("width", w as u64),
                None => j.key_null("width"),
            }
            match self.plan.as_ref().and_then(|p| p.height) {
                Some(h) => j.key_u64("height", h as u64),
                None => j.key_null("height"),
            }
            match self.plan.as_ref().and_then(|p| p.duration_ms) {
                Some(d) => j.key_u64("durationMs", d),
                None => j.key_null("durationMs"),
            }
            match self.reason.as_deref() {
                Some(r) => j.key_str("reason", r),
                None => j.key_null("reason"),
            }
            j.end();
        } else {
            j.null();
        }

        j.key("plan");
        match &self.plan {
            Some(p) => {
                j.begin_obj();
                j.key_str("mime", "video/mp4");
                j.key_bool("direct", p.direct);
                j.key("parts");
                j.begin_arr();
                for part in &p.parts {
                    j.begin_obj();
                    match part {
                        Part::Literal(b) => {
                            j.key_str("t", "lit");
                            j.key_str("b64", &base64_encode(b));
                            j.key_null("off");
                            j.key_u64("len", b.len() as u64);
                        }
                        Part::Slice { off, len } => {
                            j.key_str("t", "slice");
                            j.key_null("b64");
                            j.key_u64("off", *off);
                            j.key_u64("len", *len);
                        }
                    }
                    j.end();
                }
                j.end();
                j.end();
            }
            None => j.null(),
        }

        j.key("readMore");
        match &self.read_more {
            Some(ReadMore::Head { bytes, reason }) => {
                j.begin_obj();
                j.key_str("target", "head");
                j.key_u64("bytes", *bytes);
                j.key_str("reason", reason);
                j.end();
            }
            Some(ReadMore::Tail { bytes, reason }) => {
                j.begin_obj();
                j.key_str("target", "tail");
                j.key_u64("bytes", *bytes);
                j.key_str("reason", reason);
                j.end();
            }
            Some(ReadMore::Window {
                off,
                bytes,
                region,
                reason,
            }) => {
                j.begin_obj();
                j.key_str("target", "window");
                j.key_u64("off", *off);
                j.key_u64("bytes", *bytes);
                j.key_u64("regionOff", region.0);
                j.key_u64("regionLen", region.1);
                j.key_str("reason", reason);
                j.end();
            }
            None => j.null(),
        }

        j.key("meta");
        j.begin_obj();
        macro_rules! opt_str {
            ($k:literal, $v:expr) => {
                match $v.as_deref() {
                    Some(v) => j.key_str($k, v),
                    None => j.key_null($k),
                }
            };
        }
        opt_str!("make", self.meta.make);
        opt_str!("model", self.meta.model);
        opt_str!("software", self.meta.software);
        opt_str!("lens", self.meta.lens);
        opt_str!("takenAt", self.meta.datetime_original);
        match self.meta.orientation {
            Some(o) => j.key_u64("orientation", o as u64),
            None => j.key_null("orientation"),
        }
        j.end();

        j.key("markers");
        j.begin_arr();
        for m in &self.markers {
            j.str(m);
        }
        j.end();

        j.key("boxes");
        j.begin_arr();
        for b in &self.boxes {
            j.str(b);
        }
        j.end();

        j.key("notes");
        j.begin_arr();
        for n in &self.notes {
            j.str(n);
        }
        j.end();

        j.end();
        j.finish()
    }
}

fn sniff(s: &Sparse, file_size: u64) -> (&'static str, Option<[u8; 4]>) {
    if jpeg::is_jpeg(s) {
        return ("jpeg", None);
    }
    if heif::is_isobmff(s) {
        let brand = heif::major_brand(s);
        return match brand {
            Some(b) if heif::is_heif_brand(&b) => ("heif", brand),
            Some(b) if heif::is_avif_brand(&b) => ("avif", brand),
            // A brand we do not know is still ISOBMFF; treat it as a video
            // candidate rather than guessing at a still format.
            Some(_) => ("isobmff", brand),
            None => ("unknown", None),
        };
    }
    if s.starts_with(0, &[0x89, b'P', b'N', b'G']) {
        return ("png", None);
    }
    if s.starts_with(0, b"RIFF") && s.starts_with(8, b"WEBP") {
        return ("webp", None);
    }
    if s.starts_with(0, b"GIF8") {
        return ("gif", None);
    }
    if s.starts_with(0, b"II*\0") || s.starts_with(0, b"MM\0*") {
        return ("tiff", None);
    }
    let _ = file_size;
    ("unknown", None)
}

fn still_mime_for(container: &str) -> Option<&'static str> {
    match container {
        "jpeg" => Some("image/jpeg"),
        "heif" => Some("image/heic"),
        "avif" => Some("image/avif"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "tiff" => Some("image/tiff"),
        _ => None,
    }
}

/// Stage 1: what is this file, and where is the motion payload?
///
/// Wraps [`probe_inner`] so the still slice can be completed on every exit
/// path: a JPEG's picture ends where its video begins, whichever of the routes
/// found the video. Without it the viewer hands the decoder the whole file -
/// image plus megabytes of clip - and a browser that rejects a stream with a
/// long tail reports a perfectly good picture as undecodable.
pub fn probe(s: &Sparse, file_size: u64) -> Outcome {
    let mut out = probe_inner(s, file_size);
    if out.container == "jpeg" {
        if let Some((off, _)) = out.video {
            if off >= MIN_STILL_BYTES {
                out.still_len = out.still_len.or(Some(off));
            }
        }
    }
    out
}

fn probe_inner(s: &Sparse, file_size: u64) -> Outcome {
    let mut out = Outcome {
        file_size,
        ..Default::default()
    };
    let (container, brand) = sniff(s, file_size);
    out.container = container;
    out.still_mime = still_mime_for(container);

    let head = s.windows().next().map(|w| w.data).unwrap_or(&[]);
    let facts = xmp::scan_head(head);
    collect_markers(&mut out, &facts);
    out.boxes = top_level_boxes(s, file_size);

    let isobmff_video =
        container == "isobmff" && brand.map(|b| heif::is_mp4_brand(&b)).unwrap_or(false);

    if isobmff_video {
        out.kind = "video";
        out.plain_video = true;
        out.container = "mp4";
        out.family = Some("plain-video");
        out.confidence = "exact";
        out.method = Some("container");
        out.video = Some((0, file_size));
        out.playable = true;
        out.plan = Some(VideoPlan {
            parts: vec![Part::Slice {
                off: 0,
                len: file_size,
            }],
            direct: true,
            ..Default::default()
        });
        return out;
    }

    // ---- Samsung SEFT trailer --------------------------------------------
    //
    // Samsung ends every motion photo it writes with this trailer, and the
    // trailer sits *after* the video. Its `MotionPhoto_Data` block therefore
    // states the video's exact extent, which is both cheaper and more precise
    // than inferring it from the bytes that follow. It is the only route that
    // finds a Samsung HEIC at all: those files carry no video item, no second
    // `ftyp` and no video track.
    let trailer = seft::parse(s, file_size);
    let mut candidate: Option<(u64, u64)> = None;
    let mut extents: Vec<(u64, u64)> = Vec::new();
    let mut family: Option<&'static str> = None;
    let mut method: Option<&'static str> = None;
    let mut pending_head: Option<ReadMore> = None;

    if let Some(trailer) = &trailer {
        for marker in trailer.markers() {
            if !out.markers.contains(&marker) {
                out.markers.push(marker);
            }
        }
        out.note(format!(
            "SEFT trailer v{} with {} block(s)",
            trailer.version,
            trailer.blocks.len()
        ));
        if let Some((off, len)) = trailer.video_range(s, file_size) {
            candidate = Some((off, len));
            family = Some("samsung");
            method = Some("seft-trailer");
        } else {
            out.note("the SEFT trailer holds no motion photo block");
        }
    }

    // ---- Still metadata ---------------------------------------------------
    //
    // Parsed whatever route found the video: the inspector wants the camera,
    // the capture time and the still dimensions even when the trailer already
    // gave away the video range.
    if container == "jpeg" {
        let j = jpeg::walk(s);
        if !j.complete {
            out.note("jpeg header walk stopped early");
        }
        for seg in &j.segments {
            if seg.marker == 0xe1 {
                let Some(head_bytes) = s.read(seg.data_start, 6.min(seg.data_len as usize)) else {
                    continue;
                };
                if jpeg::is_exif_header(head_bytes) {
                    let tiff_off = seg.data_start + 6;
                    let tiff_len = seg.data_len.saturating_sub(6);
                    if let Some(e) = exif::parse(s, tiff_off, tiff_len) {
                        out.meta = e;
                    }
                }
            }
        }
        out.kind = "photo";
    }

    let mut heif_meta: Option<heif::Meta> = None;
    let mut heif_meta_incomplete = false;
    if matches!(container, "heif" | "avif") {
        out.kind = "photo";
        if let Some(meta_box) = heif::find_meta(s, file_size) {
            if let Some(head_end) = s.windows().next().map(|w| w.end()) {
                heif_meta_incomplete = meta_box.data_end > head_end;
            }
            heif_meta = heif::parse_meta(s, &meta_box);
            if let Some(meta) = &heif_meta {
                if let (Some(w), Some(h)) = (meta.width, meta.height) {
                    out.meta.width = Some(w);
                    out.meta.height = Some(h);
                }
            } else {
                out.note("the meta box is not fully inside the head window");
            }
        } else {
            out.note("no meta box found in the head window");
        }
    }

    // ---- Route selection --------------------------------------------------
    match container {
        "jpeg" => {
            if candidate.is_none() {
                if let Some((off, len)) = video_range_from_xmp(&facts, file_size) {
                    candidate = Some((off, len));
                    family = Some("google");
                    method = Some("xmp-directory");
                } else if let Some(off) = facts.micro_video_offset {
                    if off > 0 && off < file_size {
                        candidate = Some((file_size - off, off));
                        family = Some("google");
                        method = Some("xmp-microvideo-offset");
                    }
                }
                // The directory states the primary item's exact length, which
                // is more precise than "up to the video"; the wrapper below
                // fills in the fallback when it is absent.
                out.still_len = still_len_from_xmp(&facts);
            }
        }
        "heif" | "avif" => {
            if candidate.is_none() {
                // Motion Photo 1.0 for ISOBMFF stills puts the whole video in a
                // sibling `mpvd` box at the end of the file. That is the
                // structural answer Google's own extractor trusts: the XMP item
                // lengths in these files are not dependable.
                if let Some(mpvd) = seft::find_mpvd(s, file_size) {
                    let end = seft::trim_trailing_sefd(s, mpvd.data_start, mpvd.data_end);
                    if end > mpvd.data_start {
                        candidate = Some((mpvd.data_start, end - mpvd.data_start));
                        family = Some("google");
                        method = Some("mpvd-box");
                        out.note("a top-level mpvd box holds the video");
                    }
                }
                if let Some(meta) = &heif_meta {
                    if let Some(item) = meta.video_item() {
                        extents = item.extents.clone();
                        if let Some(start) = item.start() {
                            candidate = Some((start, item.total_len()));
                        }
                        family = Some(if meta.described_by_primary().contains(&item.id) {
                            "heif-item"
                        } else {
                            "heif-item-unreferenced"
                        });
                        method = Some("heif-item");
                        out.confidence = if item.contiguous() { "exact" } else { "high" };
                        out.note(format!(
                            "video item #{} type={} name={}",
                            item.id,
                            item.type_str(),
                            if item.name.is_empty() {
                                "-"
                            } else {
                                &item.name
                            }
                        ));
                        if !item.contiguous() {
                            out.note("video item uses multiple extents");
                        }
                    } else if heif_meta_incomplete {
                        // `meta` ran past the head window, so the item list may
                        // be incomplete: ask for exactly enough to finish it.
                        if let Some(meta_box) = heif::find_meta(s, file_size) {
                            pending_head = Some(ReadMore::Head {
                                bytes: meta_box.data_end.min(HEAD_WINDOW_MAX),
                                reason: "finish reading the HEIF item table",
                            });
                        }
                    } else {
                        out.note(format!(
                            "heif meta has {} items and no video item",
                            meta.items.len()
                        ));
                    }
                }
                if candidate.is_none() {
                    if let Some((off, len)) = video_range_from_xmp(&facts, file_size) {
                        // Some writers record a length that has nothing to do
                        // with the video, so a claim is only believed when the
                        // bytes it names actually begin a media box.
                        if looks_like_media_box(s, off, len) {
                            candidate = Some((off, len));
                            family = Some("heif-xmp");
                            method = Some("xmp-directory");
                        } else {
                            out.note(
                                "the XMP video length does not point at a media box; ignoring it",
                            );
                        }
                    }
                }
            }
        }
        _ => {
            out.kind = "photo";
            if candidate.is_none() {
                if let Some((off, len)) = video_range_from_xmp(&facts, file_size) {
                    candidate = Some((off, len));
                    family = Some("xmp");
                    method = Some("xmp-directory");
                }
            }
        }
    }

    if let Some(t) = facts
        .presentation_timestamp_us
        .or(facts.micro_video_timestamp_us)
    {
        out.timestamp_us = Some(t);
    }

    // ---- Planning --------------------------------------------------------
    if let Some((off, len)) = candidate {
        if off >= file_size || len == 0 || off + len > file_size {
            out.note("the video range in the metadata is out of bounds; ignoring it");
        } else {
            out.video = Some((off, len));
            if family.is_some() {
                out.family = family;
            }
            if method.is_some() {
                out.method = method;
                out.confidence = "exact";
            }
            if !extents.is_empty() && !extents_contiguous(&extents) {
                out.note("multi-extent video item: extraction needs a demuxer");
                out.reason = Some("video payload is split across several extents".into());
                kind_fixup(&mut out);
                return out;
            }
            match plan_region(s, (off, len), file_size) {
                PlanAttempt::Ready(plan) => {
                    apply_plan(&mut out, plan);
                }
                PlanAttempt::NeedWindow { off: w_off, bytes } => {
                    out.read_more = Some(ReadMore::Window {
                        off: w_off,
                        bytes,
                        region: (off, len),
                        reason: "read the video header",
                    });
                    out.reason = Some("reading the video header".into());
                }
                PlanAttempt::Unsupported(reason) => {
                    out.reason = Some(reason);
                }
            }
            kind_fixup(&mut out);
            if out.read_more.is_none() {
                out.read_more = pending_head;
            }
            return out;
        }
    }

    // No metadata range. Two structural routes remain, cheapest first: an
    // appended container that is fully visible, then the sample table.
    if matches!(
        container,
        "jpeg" | "heif" | "avif" | "png" | "webp" | "gif" | "tiff"
    ) {
        if let Some((start, len, plan)) = find_appended_container(s, file_size) {
            let family = if out.markers.iter().any(|m| m == "MotionPhoto_Data") {
                "samsung"
            } else if facts.motion_photo == Some(true) || facts.micro_video == Some(true) {
                "google"
            } else {
                "unknown"
            };
            out.video = Some((start, len));
            out.family = Some(family);
            out.method = Some("appended-container");
            out.confidence = if facts.present { "high" } else { "medium" };
            out.note("a self-contained MP4 is appended to the image data");
            apply_plan(&mut out, plan);
            kind_fixup(&mut out);
            return out;
        }
        match plan_from_moov(s, file_size, None) {
            PlanAttempt::Ready(plan) => {
                out.family = Some(if out.markers.iter().any(|m| m == "MotionPhoto_Data") {
                    "samsung"
                } else if facts.motion_photo == Some(true) || facts.micro_video == Some(true) {
                    "google"
                } else {
                    "unknown"
                });
                out.method = Some("sample-table");
                out.confidence = if facts.motion_photo == Some(true) {
                    "high"
                } else {
                    "medium"
                };
                out.note("located the video through its sample table");
                apply_plan(&mut out, plan);
                kind_fixup(&mut out);
                return out;
            }
            PlanAttempt::NeedWindow { .. } => {}
            PlanAttempt::Unsupported(_) => {}
        }
        // A bigger tail sometimes reveals a trailer moov that was just outside.
        if facts.motion_photo == Some(true)
            || facts.micro_video == Some(true)
            || !facts.directory.is_empty()
        {
            let have = s.windows().last().map(|w| w.data.len() as u64).unwrap_or(0);
            if have < TAIL_WINDOW_MAX {
                out.read_more = Some(ReadMore::Tail {
                    bytes: (have * 4).clamp(TAIL_WINDOW, TAIL_WINDOW_MAX),
                    reason: "motion photo declared but the video header is not in the tail window",
                });
                out.reason = Some("reading more of the file tail".into());
            }
        }
    }

    if out.read_more.is_none() {
        out.read_more = pending_head;
    }
    kind_fixup(&mut out);
    out
}

fn extents_contiguous(extents: &[(u64, u64)]) -> bool {
    let mut expect = None;
    for (off, len) in extents {
        if let Some(e) = expect {
            if *off != e {
                return false;
            }
        }
        expect = Some(off + len);
    }
    true
}

fn kind_fixup(out: &mut Outcome) {
    if out.plan.is_some() {
        out.kind = "motion";
    } else if out.kind == "unknown" {
        out.kind = "other";
    }
}

fn collect_markers(out: &mut Outcome, facts: &Xmp) {
    for m in &facts.samsung_markers {
        if !out.markers.contains(m) {
            out.markers.push(m.clone());
        }
    }
    if facts.motion_photo == Some(true) {
        out.markers.push("Camera:MotionPhoto".into());
    }
    if facts.micro_video == Some(true) {
        out.markers.push("GCamera:MicroVideo".into());
    }
}

fn video_range_from_xmp(facts: &Xmp, file_size: u64) -> Option<(u64, u64)> {
    // Items after the primary image are appended at the end of the file, in
    // order. Walk them backwards from EOF to place each one exactly.
    if facts.directory.len() >= 2 {
        let mut end = file_size;
        let mut found = None;
        for item in facts.directory.iter().skip(1).rev() {
            let stored = item.stored_len();
            if stored == 0 || stored > end {
                return found;
            }
            let start = end - stored;
            if item.is_video() && found.is_none() {
                found = Some((start, item.length.unwrap_or(stored)));
            }
            end = start;
        }
        if found.is_some() {
            return found;
        }
    }
    None
}

fn still_len_from_xmp(facts: &Xmp) -> Option<u64> {
    facts
        .directory
        .first()
        .filter(|i| i.is_image())
        .and_then(|i| i.length)
}

fn apply_plan(out: &mut Outcome, plan: VideoPlan) {
    if out.video.is_none() {
        // Recover the media span from the plan's slice parts.
        let off = plan
            .parts
            .iter()
            .filter_map(|p| match p {
                Part::Slice { off, .. } => Some(*off),
                _ => None,
            })
            .min();
        let len: u64 = plan
            .parts
            .iter()
            .filter_map(|p| match p {
                Part::Slice { len, .. } => Some(*len),
                _ => None,
            })
            .sum();
        if let (Some(off), true) = (off, len > 0) {
            out.video = Some((off, len));
        }
    }
    out.playable = true;
    out.reason = None;
    out.read_more = None;
    if plan.codec.is_some() && out.confidence == "none" {
        out.confidence = "medium";
    }
    out.plan = Some(plan);
}

enum PlanAttempt {
    Ready(VideoPlan),
    NeedWindow { off: u64, bytes: u64 },
    Unsupported(String),
}

/// Builds a plan for a known video byte range.
fn plan_region(s: &Sparse, region: (u64, u64), file_size: u64) -> PlanAttempt {
    let (start, len) = region;
    let end = start + len;

    // Route A: the range is already a complete MP4. One slice, zero rebuild.
    if let Some(direct) = try_direct(s, start, end, file_size) {
        return PlanAttempt::Ready(direct);
    }

    // Route B: the range came from metadata, so the bytes it names are the
    // camera's own MP4. Reading its header is worth one small read: a verbatim
    // slice is byte-exact, keeps the file's own metadata intact, and needs no
    // patching. Only when the header is already visible do we skip straight to
    // the rebuild below.
    let want = len.min(REGION_WINDOW);
    if !s.has(start, want as usize) {
        return PlanAttempt::NeedWindow {
            off: start,
            bytes: want,
        };
    }

    // Route C: rebuild from the sample table.
    match plan_from_moov(s, file_size, Some(region)) {
        PlanAttempt::Ready(mut plan) => {
            let span = plan_span(&plan);
            if let Some((s_off, s_len)) = span {
                if end < file_size && s_off + s_len > end {
                    // The samples run past the claimed range: the metadata lied,
                    // but we only ever copy real file bytes, so keep the plan
                    // only if the span still lands inside the file.
                    if s_off + s_len > file_size {
                        return PlanAttempt::Unsupported(
                            "sample table points outside the file".into(),
                        );
                    }
                }
                let _ = (start, len);
            }
            plan.direct = false;
            PlanAttempt::Ready(plan)
        }
        PlanAttempt::Unsupported(reason) => {
            // The range is known but its header is not in any window: that is
            // exactly what stage 2 exists for. Only give up if we can already
            // see the header and it still tells us nothing, which is what stops
            // the driver from looping on the same read.
            let want = len.min(REGION_WINDOW);
            if !s.has(start, want as usize) {
                PlanAttempt::NeedWindow {
                    off: start,
                    bytes: want,
                }
            } else {
                PlanAttempt::Unsupported(reason)
            }
        }
        PlanAttempt::NeedWindow { off, bytes } => PlanAttempt::NeedWindow { off, bytes },
    }
}

fn plan_span(plan: &VideoPlan) -> Option<(u64, u64)> {
    let mut min = None;
    let mut max_end = None;
    for p in &plan.parts {
        if let Part::Slice { off, len } = p {
            min = Some(min.map_or(*off, |m: u64| m.min(*off)));
            max_end = Some(max_end.map_or(off + len, |m: u64| m.max(off + len)));
        }
    }
    match (min, max_end) {
        (Some(a), Some(b)) if b > a => Some((a, b - a)),
        _ => None,
    }
}

/// True when `[start, end)` is a self-contained box chain with `ftyp`, `moov`
/// and `mdat`, which a browser can open as-is.
fn try_direct(s: &Sparse, start: u64, end: u64, file_size: u64) -> Option<VideoPlan> {
    if end > file_size {
        return None;
    }
    let first = read_box(s, start, end)?;
    if !first.is(b"ftyp") {
        return None;
    }
    let mut saw_moov = None;
    let mut saw_mdat = false;
    let mut pos = start;
    let mut steps = 0;
    while pos < end {
        steps += 1;
        if steps > 64 {
            return None;
        }
        let b = read_box(s, pos, end)?;
        if b.is(b"moov") {
            saw_moov = Some(b);
        } else if b.is(b"mdat") {
            saw_mdat = true;
        }
        pos = b.data_end;
    }
    if pos != end || saw_moov.is_none() || !saw_mdat {
        return None;
    }
    let mut plan = VideoPlan {
        parts: vec![Part::Slice {
            off: start,
            len: end - start,
        }],
        direct: true,
        ..Default::default()
    };
    if let Some(moov) = saw_moov {
        if let Some(m) = mp4::parse_moov(s, moov) {
            fill_from_moov(&mut plan, &m);
        }
    }
    Some(plan)
}

fn fill_from_moov(plan: &mut VideoPlan, moov: &Moov) {
    if let Some(t) = moov.video_trak() {
        plan.codec = t.codec_string.clone();
        if t.width > 0 {
            plan.width = Some(t.width);
        }
        if t.height > 0 {
            plan.height = Some(t.height);
        }
        plan.duration_ms = t.duration_ms().or_else(|| moov.duration_ms());
    } else {
        plan.duration_ms = moov.duration_ms();
    }
}

/// Rebuilds a playable MP4 around the sample table of a visible `moov`.
///
/// Layout produced: `ftyp` + patched `moov` + `mdat` header + the verbatim
/// sample span. Every chunk offset in the original file is shifted by
/// `(new payload start - original payload start)`, so the samples keep pointing
/// at themselves.
fn plan_from_moov(s: &Sparse, file_size: u64, want_inside: Option<(u64, u64)>) -> PlanAttempt {
    // Prefer a `moov` whose sample table agrees with the metadata range, but
    // fall back to any structurally sound one: the rebuild is driven entirely
    // by the sample table, so the claimed range is corroboration, not a
    // requirement.
    match plan_from_moov_inner(s, file_size, want_inside, true) {
        PlanAttempt::Ready(plan) => PlanAttempt::Ready(plan),
        first => match plan_from_moov_inner(s, file_size, want_inside, false) {
            PlanAttempt::Ready(plan) => PlanAttempt::Ready(plan),
            _ => first,
        },
    }
}

fn plan_from_moov_inner(
    s: &Sparse,
    file_size: u64,
    want_inside: Option<(u64, u64)>,
    require_match: bool,
) -> PlanAttempt {
    let candidates = mp4::find_moov_candidates(s, file_size);
    if candidates.is_empty() {
        return PlanAttempt::Unsupported("no moov box is visible".into());
    }
    let mut last_reason = String::from("no usable sample table");
    for hdr in candidates {
        let Some(moov) = mp4::parse_moov(s, hdr) else {
            continue;
        };
        let Some(trak) = moov.video_trak() else {
            continue;
        };
        if trak.fragmented {
            last_reason = "fragmented MP4 (moof) is not supported yet".into();
            continue;
        }
        let Some((span_start, span_len)) = trak.media_span() else {
            continue;
        };
        if span_len == 0 || trak.sample_bytes == 0 {
            continue;
        }
        if span_start < 8 || span_start + span_len > file_size {
            last_reason = "sample table points outside the file".into();
            continue;
        }
        // Guard against copying a wildly oversized span.
        if span_len > trak.sample_bytes.saturating_mul(2) + 1024 * 1024 {
            last_reason = "sample span is implausibly large".into();
            continue;
        }
        if require_match {
            if let Some((rs, rl)) = want_inside {
                if !trak.within(rs, rl) && !chunks_inside(trak, rs, rl) {
                    last_reason = "sample table does not match the metadata range".into();
                    continue;
                }
            }
        }
        // The moov bytes must be fully readable; if they are not, ask for a
        // window that contains them (they are always at one end in practice).
        let Some(moov_bytes) = s.read(hdr.start, hdr.size as usize) else {
            let need = hdr.size + 4096;
            if hdr.start + hdr.size > file_size / 2 {
                return PlanAttempt::NeedWindow {
                    off: hdr.start.saturating_sub(4096),
                    bytes: need.min(HARD_SCAN_LIMIT),
                };
            }
            last_reason = "moov box is only partially readable".into();
            continue;
        };

        let ftyp = mp4::build_ftyp(b"isom", &[*b"isom", *b"iso2", *b"avc1", *b"mp41"]);
        let mdat_header_len = if span_len + 8 > u32::MAX as u64 {
            16
        } else {
            8
        };
        let payload_start_new = ftyp.len() as u64 + hdr.size + mdat_header_len;
        let delta = payload_start_new as i64 - span_start as i64;

        let mut moov_copy = moov_bytes.to_vec();
        let fields: Vec<(usize, u32, bool)> = trak
            .chunk_offset_fields
            .iter()
            .map(|f| ((f.entries_at - hdr.start) as usize, f.entries, f.wide))
            .collect();
        let Some(patched) = mp4::patch_moov(&mut moov_copy, &fields, delta) else {
            last_reason = "chunk offsets do not fit the file layout".into();
            continue;
        };
        if patched == 0 {
            last_reason = "no chunk offsets to patch".into();
            continue;
        }

        let mut mdat_header = Vec::with_capacity(mdat_header_len as usize);
        if mdat_header_len == 16 {
            mdat_header.extend_from_slice(&1u32.to_be_bytes());
            mdat_header.extend_from_slice(b"mdat");
            mdat_header.extend_from_slice(&(span_len + 16).to_be_bytes());
        } else {
            mdat_header.extend_from_slice(&((span_len + 8) as u32).to_be_bytes());
            mdat_header.extend_from_slice(b"mdat");
        }

        let mut plan = VideoPlan {
            parts: vec![
                Part::Literal(ftyp),
                Part::Literal(moov_copy),
                Part::Literal(mdat_header),
                Part::Slice {
                    off: span_start,
                    len: span_len,
                },
            ],
            direct: false,
            ..Default::default()
        };
        fill_from_moov(&mut plan, &moov);
        return PlanAttempt::Ready(plan);
    }
    PlanAttempt::Unsupported(last_reason)
}

fn chunks_inside(trak: &mp4::Trak, start: u64, len: u64) -> bool {
    let end = start + len;
    !trak.chunks.is_empty()
        && trak
            .chunks
            .iter()
            .all(|c| c.offset >= start && c.offset + c.bytes <= end)
}

/// Stage 2: the driver read a window at a candidate video range; finish the
/// plan using that window plus whatever else it still holds.
pub fn prepare(
    region: (u64, u64),
    w1: (&[u8], u64),
    w2: Option<(&[u8], u64)>,
    file_size: u64,
) -> Outcome {
    let mut s = Sparse::new();
    s.add(w1.0, w1.1);
    if let Some((data, off)) = w2 {
        s.add(data, off);
    }
    let mut out = Outcome {
        file_size,
        kind: "motion",
        container: "unknown",
        still_mime: None,
        family: None,
        ..Default::default()
    };
    let (container, _) = sniff(&s, file_size);
    out.container = container;
    out.still_mime = still_mime_for(container);
    out.video = Some(region);
    out.family = Some("unknown");
    match plan_region(&s, region, file_size) {
        PlanAttempt::Ready(plan) => {
            out.method = Some(if plan.direct {
                "container"
            } else {
                "sample-table"
            });
            out.confidence = if plan.direct { "exact" } else { "high" };
            apply_plan(&mut out, plan);
        }
        PlanAttempt::NeedWindow { off, bytes } => {
            if bytes == 0 || off >= file_size {
                out.reason = Some("no video header found in the claimed range".into());
            } else if off == region.0 && bytes >= region.1 {
                out.reason = Some("the claimed range has no MP4 box structure".into());
            } else {
                out.read_more = Some(ReadMore::Window {
                    off,
                    bytes,
                    region,
                    reason: "read further into the video",
                });
                out.reason = Some("reading further into the video".into());
            }
        }
        PlanAttempt::Unsupported(reason) => out.reason = Some(reason),
    }
    out
}

/// Every box type at the top level, for the diagnostics panel.
pub fn top_level_boxes(s: &Sparse, file_size: u64) -> Vec<String> {
    boxes(s, 0, file_size)
        .take(32)
        .map(|b| b.type_lossy())
        .collect()
}

/// Finds a self-contained MP4 appended to the image data, with no metadata
/// help at all: a `ftyp` box whose chain of boxes walks exactly to the end of
/// the file and contains both a `moov` and an `mdat`.
///
/// This is the Samsung/Xiaomi trailer shape, and because the range is a whole
/// valid file the plan is a single verbatim slice - no rebuild, no patching.
/// It only succeeds when every top-level header is visible in a window, which
/// is true for faststart trailers and for files small enough to sit inside the
/// head window. Anything else falls through to the sample-table route.
fn find_appended_container(s: &Sparse, file_size: u64) -> Option<(u64, u64, VideoPlan)> {
    let mut best: Option<(u64, u64, VideoPlan)> = None;
    for w in s.windows() {
        for at in crate::bits::FindAll::new(w.data, b"ftyp", 16) {
            if at < 4 {
                continue;
            }
            let start = w.off + at as u64 - 4;
            // A `ftyp` at offset 0 means the file itself is the MP4, which is
            // handled by the container check before we get here.
            if start == 0 {
                continue;
            }
            let Some(plan) = try_direct(s, start, file_size, file_size) else {
                continue;
            };
            if best.as_ref().map(|(b, _, _)| start < *b).unwrap_or(true) {
                best = Some((start, file_size - start, plan));
            }
        }
    }
    best
}

/// True when the claimed range begins with a plausible media box. Used to veto
/// XMP claims, which some writers get wrong.
fn looks_like_media_box(s: &Sparse, off: u64, len: u64) -> bool {
    if len < 16 {
        return false;
    }
    match read_box(s, off, off + len) {
        Some(b) => b.is(b"ftyp") || b.is(b"moov") || b.is(b"mdat"),
        None => false,
    }
}
