//! Sparse byte views over a file that is *never fully loaded*.
//!
//! Every parser in this crate works against absolute file offsets. The bytes
//! themselves live in one or more small windows (a head window, a tail window,
//! and at most one verification window) that the browser read with
//! `File.slice()` / `FileSystemFileHandle` without copying the whole file into
//! memory. Anything a parser cannot see reports `None` instead of failing, so
//! detection still works when the interesting structures sit outside a window.

/// A contiguous run of bytes that were read from `off` in the original file.
#[derive(Clone, Copy)]
pub struct Window<'a> {
    pub data: &'a [u8],
    pub off: u64,
}

impl<'a> Window<'a> {
    pub fn new(data: &'a [u8], off: u64) -> Self {
        Window { data, off }
    }

    pub fn end(&self) -> u64 {
        self.off + self.data.len() as u64
    }

    /// Absolute offset of the last byte in this window, if it is not empty.
    pub fn last(&self) -> Option<u64> {
        if self.data.is_empty() {
            None
        } else {
            Some(self.end() - 1)
        }
    }
}

/// Up to four disjoint windows, searched in insertion order.
#[derive(Default)]
pub struct Sparse<'a> {
    wins: [Option<Window<'a>>; 4],
    len: usize,
}

impl<'a> Sparse<'a> {
    pub fn new() -> Self {
        Sparse {
            wins: [None; 4],
            len: 0,
        }
    }

    /// Adds a window. Empty slices are ignored so callers can pass "no tail".
    pub fn add(&mut self, data: &'a [u8], off: u64) -> &mut Self {
        if !data.is_empty() && self.len < self.wins.len() {
            self.wins[self.len] = Some(Window::new(data, off));
            self.len += 1;
        }
        self
    }

    pub fn windows(&self) -> impl Iterator<Item = &Window<'a>> {
        self.wins[..self.len].iter().filter_map(|w| w.as_ref())
    }

    /// Returns `len` bytes starting at absolute `off`, if a single window has
    /// them all. Never allocates and never stitches across windows.
    pub fn read(&self, off: u64, len: usize) -> Option<&'a [u8]> {
        if len == 0 {
            return None;
        }
        let end = off.checked_add(len as u64)?;
        for w in self.windows() {
            if off >= w.off && end <= w.end() {
                let start = (off - w.off) as usize;
                return Some(&w.data[start..start + len]);
            }
        }
        None
    }

    pub fn has(&self, off: u64, len: usize) -> bool {
        self.read(off, len).is_some()
    }

    pub fn byte(&self, off: u64) -> Option<u8> {
        self.read(off, 1).map(|b| b[0])
    }

    pub fn u16(&self, off: u64) -> Option<u16> {
        let b = self.read(off, 2)?;
        Some(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn u32(&self, off: u64) -> Option<u32> {
        let b = self.read(off, 4)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u16_le(&self, off: u64) -> Option<u16> {
        let b = self.read(off, 2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u32_le(&self, off: u64) -> Option<u32> {
        let b = self.read(off, 4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u64(&self, off: u64) -> Option<u64> {
        let b = self.read(off, 8)?;
        Some(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn fourcc(&self, off: u64) -> Option<[u8; 4]> {
        let b = self.read(off, 4)?;
        Some([b[0], b[1], b[2], b[3]])
    }

    /// The first `n` bytes at `off` as a UTF-8-lossy-free comparison target:
    /// returns the raw slice for `starts_with` style checks.
    pub fn starts_with(&self, off: u64, needle: &[u8]) -> bool {
        match self.read(off, needle.len()) {
            Some(b) => b == needle,
            None => false,
        }
    }

    /// Index of the first occurrence of `needle` inside the window that
    /// contains `from`, relative to `from`. Bounded by the window end so a
    /// pathological file cannot make this scan unbounded work.
    pub fn find_in_window(&self, from: u64, needle: &[u8]) -> Option<u64> {
        if needle.is_empty() {
            return None;
        }
        for w in self.windows() {
            if from < w.off || from >= w.end() {
                continue;
            }
            let start = (from - w.off) as usize;
            let hay = &w.data[start..];
            if needle.len() > hay.len() {
                continue;
            }
            if let Some(i) = find_sub(hay, needle) {
                return Some(from + i as u64);
            }
            return None; // window ends before any match: caller decides.
        }
        None
    }
}

/// Plain substring search. `haystack` is at most a few hundred KiB and the
/// needles are 4-16 bytes, so a two-byte-anchored scan beats pulling in a
/// dependency and is fast enough to stay off the profile.
pub fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let last = haystack.len() - needle.len();
    let mut i = 0usize;
    while i <= last {
        // memchr-style skip: find the first byte, then compare the tail.
        match haystack[i..=last].iter().position(|&b| b == first) {
            Some(skip) => {
                let p = i + skip;
                if &haystack[p..p + needle.len()] == needle {
                    return Some(p);
                }
                i = p + 1;
            }
            None => return None,
        }
    }
    None
}

/// All occurrences of `needle`, up to `limit` results (keeps worst-case work
/// bounded on hostile input).
pub struct FindAll<'a> {
    pub haystack: &'a [u8],
    pub needle: &'a [u8],
    pub pos: usize,
    pub remaining: usize,
}

impl<'a> FindAll<'a> {
    pub fn new(haystack: &'a [u8], needle: &'a [u8], limit: usize) -> Self {
        FindAll {
            haystack,
            needle,
            pos: 0,
            remaining: limit,
        }
    }
}

impl<'a> Iterator for FindAll<'a> {
    type Item = usize;
    fn next(&mut self) -> Option<usize> {
        if self.remaining == 0 || self.pos >= self.haystack.len() {
            return None;
        }
        let found = find_sub(&self.haystack[self.pos..], self.needle)?;
        let at = self.pos + found;
        self.pos = at + 1;
        self.remaining -= 1;
        Some(at)
    }
}

/// An ISO base media file format box header.
#[derive(Clone, Copy, Debug)]
pub struct BoxHdr {
    pub typ: [u8; 4],
    pub start: u64,
    /// Total box size including the header, or 0 when the box runs to the end
    /// of the enclosing region.
    pub size: u64,
    pub hdr_len: u64,
    pub data_start: u64,
    pub data_end: u64,
}

impl BoxHdr {
    pub fn is(&self, t: &[u8; 4]) -> bool {
        &self.typ == t
    }

    pub fn type_lossy(&self) -> String {
        fourcc_string(&self.typ)
    }
}

pub fn fourcc_string(t: &[u8; 4]) -> String {
    t.iter()
        .map(|&b| {
            if (0x20..0x7f).contains(&b) {
                b as char
            } else {
                '.'
            }
        })
        .collect()
}

/// Reads a box header at absolute `pos`. `limit` is the absolute end of the
/// enclosing region (parent box data end, or file size for top level boxes).
///
/// Returns `None` for impossible headers, which is what makes the "walk the box
/// chain to EOF" validation strong enough to trust for MP4 discovery.
pub fn read_box(s: &Sparse, pos: u64, limit: u64) -> Option<BoxHdr> {
    if pos.checked_add(8)? > limit {
        return None;
    }
    let size32 = s.u32(pos)?;
    let typ = s.fourcc(pos + 4)?;
    let (size, hdr_len) = match size32 {
        0 => (limit - pos, 8),
        1 => {
            let big = s.u64(pos + 8)?;
            if big < 16 {
                return None;
            }
            (big, 16)
        }
        n if n < 8 => return None,
        n => (n as u64, 8),
    };
    // `uuid` boxes carry 16 extra bytes of usertype after the type field.
    let mut hdr_len = hdr_len;
    if &typ == b"uuid" {
        if !s.has(pos + hdr_len, 16) {
            return None;
        }
        hdr_len += 16;
    }
    let data_start = pos + hdr_len;
    let end = pos.checked_add(size)?;
    if end > limit || end < data_start {
        return None;
    }
    Some(BoxHdr {
        typ,
        start: pos,
        size,
        hdr_len,
        data_start,
        data_end: end,
    })
}

/// Iterates sibling boxes in `[start, limit)`, skipping any box whose header
/// cannot be read. Stops at the first structural inconsistency rather than
/// guessing: callers that need to validate a chain treat "stopped early" as a
/// failure.
pub struct BoxIter<'a> {
    s: &'a Sparse<'a>,
    pos: u64,
    limit: u64,
    depth: u8,
}

pub fn boxes<'a>(s: &'a Sparse<'a>, start: u64, limit: u64) -> BoxIter<'a> {
    BoxIter {
        s,
        pos: start,
        limit,
        depth: 0,
    }
}

impl<'a> Iterator for BoxIter<'a> {
    type Item = BoxHdr;
    fn next(&mut self) -> Option<BoxHdr> {
        if self.depth > 24 || self.pos >= self.limit {
            return None;
        }
        self.depth += 1;
        let hdr = read_box(self.s, self.pos, self.limit)?;
        if hdr.data_end <= self.pos {
            return None;
        }
        self.pos = hdr.data_end;
        Some(hdr)
    }
}

/// Finds the first child box of `parent` with the given type.
pub fn child<'a>(s: &'a Sparse<'a>, parent: &BoxHdr, typ: &[u8; 4]) -> Option<BoxHdr> {
    boxes(s, parent.data_start, parent.data_end).find(|b| b.is(typ))
}

/// Collects the children of `parent` with the given type.
pub fn children<'a>(s: &'a Sparse<'a>, parent: &BoxHdr, typ: &[u8; 4]) -> Vec<BoxHdr> {
    boxes(s, parent.data_start, parent.data_end)
        .filter(|b| b.is(typ))
        .collect()
}
