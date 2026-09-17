//! A dependency-free JSON writer and base64 encoder.
//!
//! The WASM boundary is one JSON document per call. Hand-rolling both keeps the
//! artifact small (no serde) and keeps allocation predictable, which matters
//! because this code runs on the main thread's worker pool for every file in a
//! folder.

pub struct J {
    s: String,
    stack: Vec<(char, bool)>,
    expecting_value: bool,
}

impl Default for J {
    fn default() -> Self {
        J::new()
    }
}

impl J {
    pub fn new() -> Self {
        J {
            s: String::with_capacity(512),
            stack: Vec::with_capacity(8),
            expecting_value: false,
        }
    }

    pub fn finish(self) -> String {
        self.s
    }

    fn pre(&mut self) {
        if self.expecting_value {
            return;
        }
        if let Some(top) = self.stack.last_mut() {
            if top.1 {
                self.s.push(',');
            } else {
                top.1 = true;
            }
        }
    }

    fn done(&mut self) {
        self.expecting_value = false;
    }

    pub fn key(&mut self, k: &str) {
        self.pre();
        self.push_str(k);
        self.s.push(':');
        self.expecting_value = true;
    }

    pub fn begin_obj(&mut self) {
        self.pre();
        self.s.push('{');
        self.stack.push(('}', false));
        self.done();
    }

    pub fn begin_arr(&mut self) {
        self.pre();
        self.s.push('[');
        self.stack.push((']', false));
        self.done();
    }

    pub fn end(&mut self) {
        if let Some((close, _)) = self.stack.pop() {
            self.s.push(close);
        }
        self.done();
    }

    pub fn str(&mut self, v: &str) {
        self.pre();
        self.push_str(v);
        self.done();
    }

    pub fn u64(&mut self, v: u64) {
        self.pre();
        let mut buf = [0u8; 20];
        let digits = num_to_str(v, &mut buf);
        self.s.push_str(digits);
        self.done();
    }

    pub fn i64(&mut self, v: i64) {
        self.pre();
        let mut buf = [0u8; 20];
        if v < 0 {
            self.s.push('-');
            let digits = num_to_str(v.unsigned_abs(), &mut buf);
            self.s.push_str(digits);
        } else {
            let digits = num_to_str(v as u64, &mut buf);
            self.s.push_str(digits);
        }
        self.done();
    }

    /// Emits a rounded integer when the value is finite and in range; JSON has
    /// no NaN/Infinity, and this crate never needs them.
    pub fn f64(&mut self, v: f64) {
        if !v.is_finite() {
            self.null();
            return;
        }
        if v == v.trunc() && v.abs() < 9.007_199_254_740_992e15 {
            self.i64(v as i64);
        } else {
            self.i64(v.round() as i64);
        }
    }

    pub fn bool(&mut self, v: bool) {
        self.pre();
        self.s.push_str(if v { "true" } else { "false" });
        self.done();
    }

    pub fn null(&mut self) {
        self.pre();
        self.s.push_str("null");
        self.done();
    }

    pub fn key_str(&mut self, k: &str, v: &str) {
        self.key(k);
        self.str(v);
    }

    pub fn key_u64(&mut self, k: &str, v: u64) {
        self.key(k);
        self.u64(v);
    }

    pub fn key_i64(&mut self, k: &str, v: i64) {
        self.key(k);
        self.i64(v);
    }

    pub fn key_bool(&mut self, k: &str, v: bool) {
        self.key(k);
        self.bool(v);
    }

    pub fn key_null(&mut self, k: &str) {
        self.key(k);
        self.null();
    }

    fn push_str(&mut self, v: &str) {
        self.s.push('"');
        for c in v.chars() {
            match c {
                '"' => self.s.push_str("\\\""),
                '\\' => self.s.push_str("\\\\"),
                '\n' => self.s.push_str("\\n"),
                '\r' => self.s.push_str("\\r"),
                '\t' => self.s.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    // Only control characters need escaping; skip the rest.
                    self.s.push_str("\\u00");
                    let n = c as u32;
                    self.s.push(HEX[(n >> 4) as usize] as char);
                    self.s.push(HEX[(n & 0xf) as usize] as char);
                }
                c => self.s.push(c),
            }
        }
        self.s.push('"');
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn num_to_str(mut v: u64, buf: &mut [u8; 20]) -> &str {
    let mut i = buf.len();
    if v == 0 {
        i -= 1;
        buf[i] = b'0';
    }
    while v > 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    core::str::from_utf8(&buf[i..]).unwrap_or("0")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding, so `atob` on the JS side can decode it
/// directly. Used only for small synthesized headers (an MP4 `ftyp`, a patched
/// `moov`), never for bulk media.
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0u8, 0, 0]), "AAAA");
        assert_eq!(base64_encode(&[255u8, 255, 255]), "////");
    }

    #[test]
    fn json_builder_nests_and_escapes() {
        let mut j = J::new();
        j.begin_obj();
        j.key_str("a", "x\"y\n");
        j.key("b");
        j.begin_arr();
        j.u64(1);
        j.u64(2);
        j.begin_obj();
        j.key_bool("c", true);
        j.end();
        j.end();
        j.key_null("d");
        j.end();
        assert_eq!(
            j.finish(),
            "{\"a\":\"x\\\"y\\n\",\"b\":[1,2,{\"c\":true}],\"d\":null}"
        );
    }

    #[test]
    fn json_escapes_control_characters() {
        let mut j = J::new();
        j.str("\u{1}\u{1f}");
        assert_eq!(j.finish(), "\"\\u0001\\u001f\"");
    }

    #[test]
    fn numbers_render_without_float_noise() {
        let mut j = J::new();
        j.begin_arr();
        j.u64(0);
        j.i64(-7);
        j.f64(1234.0);
        j.f64(f64::NAN);
        j.end();
        assert_eq!(j.finish(), "[0,-7,1234,null]");
    }
}
