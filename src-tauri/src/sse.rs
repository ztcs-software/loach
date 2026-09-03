//! Server-Sent Events framing shared by the two transports that speak it:
//! the OpenAI-compatible chat stream (`providers::openai`) and the MCP
//! Streamable-HTTP client (`mcp::client`).
//!
//! Only the frame-boundary scan lives here. Everything above it — what a
//! `data:` line means, how `[DONE]` terminates a run — is transport-specific
//! and stays with its owner.

/// Position and length of the blank line ending the first frame in `buf`.
///
/// Returns the delimiter length too so the caller consumes all of it —
/// dropping only 2 bytes of a `\r\n\r\n` would leave a stray `\r\n` glued to
/// the front of the next frame. When both forms match at overlapping offsets
/// the earlier one wins, and a CRLF pair is reported at its `\r` so the frame
/// text excludes it.
pub fn find_frame_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n");
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(a), Some(b)) => {
            if a <= b {
                Some((a, 2))
            } else {
                Some((b, 4))
            }
        }
        (Some(a), None) => Some((a, 2)),
        (None, Some(b)) => Some((b, 4)),
        (None, None) => None,
    }
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
    }
}
