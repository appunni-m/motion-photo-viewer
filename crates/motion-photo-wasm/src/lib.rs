//! Raw-ABI WebAssembly entry points.
//!
//! No wasm-bindgen: the module exports six `extern "C"` functions and the
//! browser drives them with `WebAssembly.instantiate`. That keeps the artifact
//! small, removes a version-coupled JS glue layer from the build, and means the
//! exact same functions can be called from Rust tests and from Node.
//!
//! Calling convention:
//!
//! * `mp_alloc` / `mp_free` manage input buffers. JavaScript allocates, writes
//!   the window bytes into WASM memory, and frees when the call returns.
//! * Results are a little-endian `u32` length followed by UTF-8 JSON, returned
//!   as a pointer that JavaScript reads and then releases with
//!   `mp_free_result`.
//! * Offsets and sizes cross the boundary as `f64`, which is exact for integers
//!   below 2^53 and avoids `BigInt` marshalling for multi-gigabyte files.

use core::slice;

pub mod bits;
pub mod exif;
pub mod heif;
pub mod jpeg;
pub mod json;
pub mod mp4;
pub mod probe;
pub mod seft;
pub mod xmp;

/// Allocates `len` bytes for the caller to write input into.
#[no_mangle]
pub extern "C" fn mp_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Releases a buffer obtained from [`mp_alloc`]. `len` must be the same value.
///
/// # Safety
/// `ptr` must come from `mp_alloc(len)` and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn mp_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Releases a result buffer returned by `mp_probe` / `mp_prepare`.
///
/// # Safety
/// `ptr` must be a pointer previously returned by this module.
#[no_mangle]
pub unsafe extern "C" fn mp_free_result(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let len = u32::from_le_bytes(*(ptr as *const [u8; 4])) as usize;
    let total = len + 4;
    drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(
        ptr, total,
    )));
}

fn to_result(text: String) -> *mut u8 {
    let bytes = text.into_bytes();
    let mut buf = Vec::with_capacity(bytes.len() + 4);
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(&bytes);
    let boxed: Box<[u8]> = buf.into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// # Safety
/// `ptr`/`len` must describe a readable region, or be null/0.
unsafe fn as_slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, len)
    }
}

fn as_u64(v: f64) -> u64 {
    if v.is_finite() && v > 0.0 {
        v as u64
    } else {
        0
    }
}

/// Stage 1: identify the file and locate the motion payload.
///
/// `head` is the first `head_len` bytes of the file (file offset 0) and `tail`
/// the last `tail_len` bytes. Either may be empty. Returns JSON; see
/// `docs/FORMATS.md` for the shape.
///
/// # Safety
/// Pointers must be valid for the given lengths, or null with length 0.
#[no_mangle]
pub unsafe extern "C" fn mp_probe(
    head: *const u8,
    head_len: usize,
    tail: *const u8,
    tail_len: usize,
    file_size: f64,
) -> *mut u8 {
    let file_size = as_u64(file_size);
    let head = as_slice(head, head_len);
    let tail = as_slice(tail, tail_len);
    let tail_off = file_size.saturating_sub(tail.len() as u64);
    let mut s = bits::Sparse::new();
    s.add(head, 0);
    s.add(tail, tail_off);
    let outcome = probe::probe(&s, file_size);
    to_result(outcome.to_json())
}

/// Stage 2: finish the plan for a known video byte range using a window the
/// driver read at (or around) that range.
///
/// # Safety
/// Pointers must be valid for the given lengths, or null with length 0.
#[no_mangle]
pub unsafe extern "C" fn mp_prepare(
    region_off: f64,
    region_len: f64,
    w1: *const u8,
    w1_len: usize,
    w1_off: f64,
    w2: *const u8,
    w2_len: usize,
    w2_off: f64,
    file_size: f64,
) -> *mut u8 {
    let region = (as_u64(region_off), as_u64(region_len));
    let w1 = as_slice(w1, w1_len);
    let w2 = as_slice(w2, w2_len);
    let w2 = if w2.is_empty() {
        None
    } else {
        Some((w2, as_u64(w2_off)))
    };
    let outcome = probe::prepare(region, (w1, as_u64(w1_off)), w2, as_u64(file_size));
    to_result(outcome.to_json())
}

#[cfg(test)]
mod abi_tests {
    use super::*;
    use crate::heif::tests::synth_heic;
    use crate::mp4::build_ftyp;

    /// Reads a result pointer the way JavaScript does.
    unsafe fn read_result(ptr: *mut u8) -> String {
        assert!(!ptr.is_null());
        let len = u32::from_le_bytes(*(ptr as *const [u8; 4])) as usize;
        let bytes = slice::from_raw_parts(ptr.add(4), len).to_vec();
        mp_free_result(ptr);
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn alloc_free_round_trip() {
        unsafe {
            let p = mp_alloc(64);
            assert!(!p.is_null());
            slice::from_raw_parts_mut(p, 64).fill(7);
            mp_free(p, 64);
            assert_eq!(mp_alloc(0), mp_alloc(0)); // dangling but stable
        }
    }

    #[test]
    fn null_pointers_are_tolerated() {
        unsafe {
            let json = read_result(mp_probe(core::ptr::null(), 0, core::ptr::null(), 0, 0.0));
            assert!(json.starts_with('{'));
            assert!(json.contains("\"container\":\"unknown\""));
        }
    }

    #[test]
    fn probes_a_jpeg_with_an_appended_mp4() {
        // JPEG shell + a real (tiny) MP4 appended, exactly like a Samsung
        // motion photo, with no XMP at all.
        let mut file = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
        file.extend_from_slice(&[0xff, 0xda, 0x00, 0x02]);
        file.extend_from_slice(&[0x11; 1024]);
        file.extend_from_slice(&[0xff, 0xd9]);

        let ftyp = build_ftyp(b"isom", &[*b"isom", *b"mp41"]);
        let mdat_hdr = crate::mp4::tests::mdat_header(512);
        let video_off = file.len() as u64;
        let payload_at = video_off + ftyp.len() as u64 + mdat_hdr.len() as u64;
        file.extend_from_slice(&ftyp);
        file.extend_from_slice(&mdat_hdr);
        file.extend_from_slice(&[0xAB; 512]);
        file.extend_from_slice(&crate::mp4::tests::build_moov(payload_at as u32, 512));

        let file_size = file.len() as u64;
        let tail_start = file.len().saturating_sub(4096);
        let json = unsafe {
            read_result(mp_probe(
                file.as_ptr(),
                1024,
                file[tail_start..].as_ptr(),
                file.len() - tail_start,
                file_size as f64,
            ))
        };
        assert!(json.contains("\"container\":\"jpeg\""), "{json}");
        assert!(json.contains("\"kind\":\"motion\""), "{json}");
        // A faststart trailer is a whole valid MP4, so the plan is one slice
        // starting at its ftyp - no rebuild needed.
        assert!(json.contains("\"method\":\"appended-container\""), "{json}");
        assert!(json.contains("\"playable\":true"), "{json}");
        assert!(json.contains("\"direct\":true"), "{json}");
        assert!(json.contains(&format!("\"off\":{video_off}")), "{json}");
        assert!(!json.contains("\"t\":\"lit\""), "{json}");
        assert!(json.contains("\"codec\":\"avc1.42E01E\""), "{json}");
    }

    /// Builds a HEIC whose video item holds a complete little MP4.
    fn heic_with_video_item(pad_to: usize) -> (Vec<u8>, u64, u64) {
        let ftyp = build_ftyp(b"isom", &[*b"isom"]);
        let payload = vec![0x33u8; 256];
        let mdat_hdr = crate::mp4::tests::mdat_header(payload.len() as u32);
        let mut inner = ftyp;
        let payload_at = inner.len() as u64 + mdat_hdr.len() as u64;
        inner.extend_from_slice(&mdat_hdr);
        inner.extend_from_slice(&payload);
        inner.extend_from_slice(&crate::mp4::tests::build_moov(
            payload_at as u32,
            payload.len() as u32,
        ));

        let mut file = synth_heic(4096, inner.len() as u64);
        file[4096..4096 + inner.len()].copy_from_slice(&inner);
        if file.len() < pad_to {
            file.resize(pad_to, 0);
        }
        (file, 4096, inner.len() as u64)
    }

    #[test]
    fn heic_video_item_that_is_already_a_complete_mp4_needs_no_extra_reads() {
        // The whole MP4 (ftyp + mdat + moov) sits in the range, so stage 1 can
        // answer with a single verbatim slice: zero rebuild, zero extra reads.
        let (file, off, len) = heic_with_video_item(0);
        // Put the range in the tail window so no extra read is required.
        let json = unsafe {
            read_result(mp_probe(
                file.as_ptr(),
                2048,
                file[off as usize..].as_ptr(),
                len as usize,
                file.len() as f64,
            ))
        };
        assert!(json.contains("\"container\":\"heif\""), "{json}");
        assert!(json.contains("\"method\":\"heif-item\""), "{json}");
        assert!(json.contains("\"direct\":true"), "{json}");
        assert!(json.contains("\"readMore\":null"), "{json}");
        assert!(json.contains("\"codec\":\"avc1.42E01E\""), "{json}");
        assert!(json.contains(&format!("\"off\":{off}")), "{json}");
    }

    #[test]
    fn heic_video_item_outside_the_windows_triggers_a_targeted_read() {
        // Pad the file so the video range is in neither the head nor the tail:
        // the driver must be asked for exactly one window at the range start.
        let (file, off, len) = heic_with_video_item(200_000);
        let json = unsafe {
            read_result(mp_probe(
                file.as_ptr(),
                2048,
                file[file.len() - 1024..].as_ptr(),
                1024,
                file.len() as f64,
            ))
        };
        assert!(json.contains("\"target\":\"window\""), "{json}");
        assert!(json.contains(&format!("\"off\":{off}")), "{json}");
        assert!(json.contains(&format!("\"regionOff\":{off}")), "{json}");
        assert!(json.contains("\"playable\":false"), "{json}");

        // Stage 2 with that window produces a playable single-slice plan.
        let win = &file[off as usize..(off + len) as usize];
        let json2 = unsafe {
            read_result(mp_prepare(
                off as f64,
                len as f64,
                win.as_ptr(),
                win.len(),
                off as f64,
                core::ptr::null(),
                0,
                0.0,
                file.len() as f64,
            ))
        };
        assert!(json2.contains("\"playable\":true"), "{json2}");
        assert!(json2.contains("\"direct\":true"), "{json2}");
        assert!(json2.contains("\"codec\":\"avc1.42E01E\""), "{json2}");
    }

    #[test]
    fn heic_video_item_without_ftyp_is_rebuilt_around_its_moov() {
        // Some writers store the video item as moov + mdat with no leading
        // ftyp. The plan must synthesize the ftyp and patch the chunk offsets.
        let payload = vec![0x44u8; 128];
        let mdat_hdr = crate::mp4::tests::mdat_header(payload.len() as u32);
        let mut inner = Vec::new();
        let moov_len = crate::mp4::tests::build_moov(0, payload.len() as u32).len() as u64;
        let payload_at = moov_len + mdat_hdr.len() as u64;
        // Chunk offsets in a real file are absolute from the start of the file,
        // and this item lands at 4096.
        inner.extend_from_slice(&crate::mp4::tests::build_moov(
            (4096 + payload_at) as u32,
            payload.len() as u32,
        ));
        inner.extend_from_slice(&mdat_hdr);
        inner.extend_from_slice(&payload);

        let mut file = synth_heic(4096, inner.len() as u64);
        file[4096..4096 + inner.len()].copy_from_slice(&inner);
        file.resize(200_000, 0);

        let json = unsafe {
            read_result(mp_probe(
                file.as_ptr(),
                2048,
                file[file.len() - 1024..].as_ptr(),
                1024,
                file.len() as f64,
            ))
        };
        assert!(json.contains("\"target\":\"window\""), "{json}");

        let win = &file[4096..4096 + inner.len()];
        let json2 = unsafe {
            read_result(mp_prepare(
                4096.0,
                inner.len() as f64,
                win.as_ptr(),
                win.len(),
                4096.0,
                core::ptr::null(),
                0,
                0.0,
                file.len() as f64,
            ))
        };
        assert!(json2.contains("\"playable\":true"), "{json2}");
        assert!(json2.contains("\"direct\":false"), "{json2}");
        // ftyp + patched moov + mdat header are synthesized; the samples are a
        // verbatim slice of the original file.
        assert_eq!(json2.matches("\"t\":\"lit\"").count(), 3, "{json2}");
        assert_eq!(json2.matches("\"t\":\"slice\"").count(), 1, "{json2}");
        assert!(
            json2.contains(&format!("\"off\":{}", 4096 + payload_at)),
            "{json2}"
        );
        assert!(
            json2.contains(&format!("\"len\":{}", payload.len())),
            "{json2}"
        );
    }
}
