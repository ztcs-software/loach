//! Server-Sent Events framing shared by the two transports that speak it:
//! the OpenAI-compatible chat stream (`providers::openai`) and the MCP
//! Streamable-HTTP client (`mcp::client`).
//!
//! Only the frame-boundary scan and line splitting live here. Everything
//! above it — what a `data:` line means, how `[DONE]` terminates a run — is
//! transport-specific and stays with its owner.

/// Length of the line ending at `buf[i]`, if one starts there. The spec
/// allows `\r\n`, `\n` and a lone `\r`; `\r\n` is always one ending, never a
/// `\r` line followed by an empty `\n` one.
fn line_end_at(buf: &[u8], i: usize) -> Option<usize> {
    match buf.get(i)? {
        b'\r' if buf.get(i + 1) == Some(&b'\n') => Some(2),
        b'\r' | b'\n' => Some(1),
        _ => None,
    }
}

/// Position and length of the blank line ending the first frame in `buf`:
/// a line ending followed straight by another, in any mix of the three the
/// spec allows (`\n\n`, `\r\n\r\n`, `\r\r`, `\n\r\n`, …).
///
/// Returns the delimiter length too so the caller consumes all of it —
/// dropping only 2 bytes of a `\r\n\r\n` would leave a stray `\r\n` glued to
/// the front of the next frame. The position is where the first ending
/// starts, so the frame text excludes it.
///
/// A `\r` that is the last byte of `buf` may be the start of a `\r\n` still
/// in flight. As the second ending it already settles that the frame is over,
/// so the frame is reported rather than held back; if a `\n` does follow, it
/// is left at the head of the next frame, where it reads as an empty line.
pub fn find_frame_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < buf.len() {
        match line_end_at(buf, i) {
            Some(first) => {
                if let Some(second) = line_end_at(buf, i + first) {
                    return Some((i, first + second));
                }
                i += first;
            }
            None => i += 1,
        }
    }
    None
}

/// The lines of one frame, split at any of the spec's line endings — `\r\n`,
/// `\n` or a lone `\r`. `str::lines` knows only the first two, so a server
/// ending its lines with `\r` alone had a whole frame read as one line.
pub fn frame_lines(frame: &str) -> impl Iterator<Item = &str> {
    frame.split('\n').flat_map(|line| {
        line.strip_suffix('\r').unwrap_or(line).split('\r')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lf_frame_reports_position_and_two_byte_delimiter() {
        assert_eq!(find_frame_end(b"data: x\n\nrest"), Some((7, 2)));
    }

    #[test]
    fn crlf_frame_reports_position_and_four_byte_delimiter() {
        // Position is the `\r`, so the frame text excludes the whole pair.
        assert_eq!(find_frame_end(b"data: x\r\n\r\nrest"), Some((7, 4)));
    }

    #[test]
    fn earlier_delimiter_wins_when_both_forms_appear() {
        assert_eq!(find_frame_end(b"a\n\nb\r\n\r\n"), Some((1, 2)));
        assert_eq!(find_frame_end(b"a\r\n\r\nb\n\n"), Some((1, 4)));
    }

    #[test]
    fn incomplete_frames_report_nothing() {
        assert_eq!(find_frame_end(b"data: partial"), None);
        assert_eq!(find_frame_end(b""), None);
        // A single CRLF is a line break inside a frame, not a frame end.
        assert_eq!(find_frame_end(b"data: x\r\ny"), None);
        assert_eq!(find_frame_end(b"data: x\ry"), None);
        // A trailing `\r` may be half of a `\r\n`; one line ending so far.
        assert_eq!(find_frame_end(b"data: x\r"), None);
        assert_eq!(find_frame_end(b"data: x\r\n"), None);
    }

    /// Every pairing of the spec's three line endings ends a frame — these
    /// used to sit in the buffer until the 1 MiB abort.
    #[test]
    fn cr_only_and_mixed_endings_end_a_frame() {
        assert_eq!(find_frame_end(b"data: x\r\rrest"), Some((7, 2)));
        assert_eq!(find_frame_end(b"data: x\n\r\nrest"), Some((7, 3)));
        assert_eq!(find_frame_end(b"data: x\r\n\nrest"), Some((7, 3)));
        assert_eq!(find_frame_end(b"data: x\r\r\nrest"), Some((7, 3)));
        assert_eq!(find_frame_end(b"data: x\n\rrest"), Some((7, 2)));
        // Lines inside the frame may end any way too.
        assert_eq!(find_frame_end(b"event: m\rdata: x\r\r"), Some((16, 2)));
    }

    /// A `\r` at the end of what has arrived ends the frame when it is the
    /// second ending — whatever follows it can't undo that.
    #[test]
    fn a_trailing_cr_as_the_second_ending_settles_the_frame() {
        assert_eq!(find_frame_end(b"data: x\r\n\r"), Some((7, 3)));
        assert_eq!(find_frame_end(b"data: x\n\r"), Some((7, 2)));
    }

    #[test]
    fn frame_lines_splits_at_every_line_ending() {
        let lines: Vec<&str> = frame_lines("event: m\r\ndata: a\ndata: b\rid: 7").collect();
        assert_eq!(lines, ["event: m", "data: a", "data: b", "id: 7"]);
        // `\r\n` is one ending, not a line plus an empty one.
        assert_eq!(frame_lines("a\r\nb").collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(frame_lines("a\r\rb").collect::<Vec<_>>(), ["a", "", "b"]);
    }
}
