//! Text encodings for the workspace file tools.
//!
//! The model reads and writes Rust strings; a file on disk is bytes in
//! whatever encoding the program that saved it chose. Most are UTF-8, but a
//! Windows machine is full of exceptions — files saved in the ANSI code page
//! (Windows-1250 on a Polish system), PowerShell 5.1's UTF-16 output — and
//! treating those as UTF-8 either garbles every non-ASCII character or
//! refuses the file as binary.
//!
//! So every file the tools read is decoded here, remembering how it was
//! stored, and every change is encoded back the same way: an edit to a
//! Windows-1250 file changes the edited bytes and nothing else.
//!
//! Detection, in order of certainty:
//!
//!   1. a byte-order mark — UTF-8, UTF-16LE or UTF-16BE, unambiguous;
//!   2. a NUL byte and no BOM — binary, not text;
//!   3. valid UTF-8 — UTF-8 (pure ASCII lands here too);
//!   4. anything else — a legacy encoding, guessed by `chardetng`, the
//!      detector Firefox uses for unlabelled pages.
//!
//! Step 4 is a guess, and two things keep a wrong one from doing damage.
//! A file is only offered for editing when encoding its decoded text again
//! reproduces the original bytes exactly ([`Decoded::lossless`]), so the
//! bytes an edit doesn't touch are always written back unchanged. And new
//! text holding a character the encoding has no bytes for is refused
//! outright ([`encode`]) rather than stored as `?` or `&#…;`. What a wrong
//! guess between two similar encodings *can* still get wrong is how the
//! model's new non-ASCII characters are stored — which is why `read_file`
//! names the encoding it used.

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF16LE_BOM: &[u8] = b"\xFF\xFE";
const UTF16BE_BOM: &[u8] = b"\xFE\xFF";

/// How a text file is stored on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextEncoding {
    /// UTF-8, with or without a byte-order mark (kept either way).
    Utf8 {
        bom: bool,
    },
    /// UTF-16 is only ever recognised by its byte-order mark, which is kept.
    Utf16Le,
    Utf16Be,
    /// A legacy encoding (Windows-1250, Shift_JIS, …), guessed from the bytes.
    Legacy(&'static Encoding),
}

impl TextEncoding {
    /// UTF-8 with or without a BOM — the case that needs no note to the model.
    pub(super) fn is_utf8(self) -> bool {
        matches!(self, TextEncoding::Utf8 { .. })
    }

    /// Name as a person (or the model) would recognise it.
    pub(super) fn name(self) -> &'static str {
        match self {
            TextEncoding::Utf8 { bom: false } => "UTF-8",
            TextEncoding::Utf8 { bom: true } => "UTF-8 with BOM",
            TextEncoding::Utf16Le => "UTF-16LE",
            TextEncoding::Utf16Be => "UTF-16BE",
            TextEncoding::Legacy(e) => e.name(),
        }
    }

    fn bom_len(self) -> usize {
        match self {
            TextEncoding::Utf8 { bom: true } => UTF8_BOM.len(),
            TextEncoding::Utf16Le | TextEncoding::Utf16Be => 2,
            _ => 0,
        }
    }

    fn codec(self) -> &'static Encoding {
        match self {
            TextEncoding::Utf8 { .. } => UTF_8,
            TextEncoding::Utf16Le => UTF_16LE,
            TextEncoding::Utf16Be => UTF_16BE,
            TextEncoding::Legacy(e) => e,
        }
    }
}

/// A file's text, and how to write it back.
pub(super) struct Decoded {
    pub text: String,
    pub encoding: TextEncoding,
    /// Whether encoding `text` again reproduces the file byte for byte.
    /// False when some bytes didn't decode — they show up as U+FFFD — and
    /// such a file can be read but not safely edited.
    pub lossless: bool,
}

/// Work out how `bytes` is encoded; `None` means binary.
///
/// `complete` is false when `bytes` is only the start of a file, so a
/// multi-byte UTF-8 character cut in half at the end of the sample isn't
/// mistaken for invalid UTF-8.
pub(super) fn detect(bytes: &[u8], complete: bool) -> Option<TextEncoding> {
    if bytes.starts_with(UTF8_BOM) {
        return Some(TextEncoding::Utf8 { bom: true });
    }
    if bytes.starts_with(UTF16LE_BOM) {
        return Some(TextEncoding::Utf16Le);
    }
    if bytes.starts_with(UTF16BE_BOM) {
        return Some(TextEncoding::Utf16Be);
    }
    if bytes.contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => Some(TextEncoding::Utf8 { bom: false }),
        // `error_len() == None`: the input ended mid-character.
        Err(e) if !complete && e.error_len().is_none() => Some(TextEncoding::Utf8 { bom: false }),
        Err(_) => {
            let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
            detector.feed(bytes, complete);
            Some(TextEncoding::Legacy(
                detector.guess(None, Utf8Detection::Deny),
            ))
        }
    }
}

/// Decode a file's bytes; `None` means binary. See [`detect`] for
/// `complete`.
pub(super) fn decode(bytes: &[u8], complete: bool) -> Option<Decoded> {
    let encoding = detect(bytes, complete)?;
    let body = &bytes[encoding.bom_len()..];
    let codec = encoding.codec();
    let (text, lossless) = match codec.decode_without_bom_handling_and_without_replacement(body) {
        Some(text) => {
            let text = text.into_owned();
            // UTF-8 and UTF-16 that decode cleanly always encode back
            // identically; a legacy encoding is checked rather than assumed.
            let lossless = match encoding {
                TextEncoding::Legacy(e) => {
                    let (again, _, unmappable) = e.encode(&text);
                    !unmappable && again.as_ref() == body
                }
                _ => true,
            };
            (text, lossless)
        }
        None => (
            codec.decode_without_bom_handling(body).0.into_owned(),
            false,
        ),
    };
    // A BOM-marked file can still turn out to be binary — UTF-32 read as
    // UTF-16 decodes to text full of NULs.
    if text.contains('\0') {
        return None;
    }
    Some(Decoded {
        text,
        encoding,
        lossless,
    })
}

/// Encode `text` the way a file stored as `encoding` is, byte-order mark
/// included. `Err` lists (a few of) the characters `encoding` has no bytes
/// for; the caller refuses the write instead of letting them turn into `?`.
pub(super) fn encode(text: &str, encoding: TextEncoding) -> Result<Vec<u8>, Vec<char>> {
    match encoding {
        TextEncoding::Utf8 { bom } => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if bom {
                out.extend_from_slice(UTF8_BOM);
            }
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        // encoding_rs only decodes UTF-16, so the two byte orders are
        // written by hand. Every character has a UTF-16 form.
        TextEncoding::Utf16Le => Ok(UTF16LE_BOM
            .iter()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect()),
        TextEncoding::Utf16Be => Ok(UTF16BE_BOM
            .iter()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect()),
        TextEncoding::Legacy(e) => {
            let (bytes, _, unmappable) = e.encode(text);
            if !unmappable {
                return Ok(bytes.into_owned());
            }
            let mut missing: Vec<char> = Vec::new();
            let mut buf = [0u8; 4];
            for c in text.chars() {
                if missing.len() == 5 {
                    break;
                }
                if !missing.contains(&c) && e.encode(c.encode_utf8(&mut buf)).2 {
                    missing.push(c);
                }
            }
            Err(missing)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::WINDOWS_1250;

    const POLISH: &str = "Zażółć gęślą jaźń\nPchnąć w tę łódź jeża lub ośm skrzyń fig.\n";

    fn cp1250(s: &str) -> Vec<u8> {
        WINDOWS_1250.encode(s).0.into_owned()
    }

    #[test]
    fn plain_utf8_and_ascii_are_utf8() {
        let d = decode(POLISH.as_bytes(), true).unwrap();
        assert_eq!(d.encoding, TextEncoding::Utf8 { bom: false });
        assert!(d.lossless);
        assert_eq!(d.text, POLISH);
        assert_eq!(
            decode(b"plain ascii\n", true).unwrap().encoding,
            TextEncoding::Utf8 { bom: false }
        );
    }

    #[test]
    fn windows_1250_is_detected_and_round_trips() {
        let bytes = cp1250(POLISH);
        let d = decode(&bytes, true).unwrap();
        assert_eq!(
            d.encoding,
            TextEncoding::Legacy(WINDOWS_1250),
            "{}",
            d.encoding.name()
        );
        assert!(d.lossless);
        assert_eq!(d.text, POLISH);
        assert_eq!(encode(&d.text, d.encoding).unwrap(), bytes);
    }

    /// Even a one-line file saved by a Polish Notepad should be read right:
    /// short input is where a statistical guess is weakest.
    #[test]
    fn a_short_windows_1250_line_is_still_detected() {
        let d = decode(&cp1250("Hasło: zażółć\n"), true).unwrap();
        assert_eq!(
            d.encoding,
            TextEncoding::Legacy(WINDOWS_1250),
            "{}",
            d.encoding.name()
        );
        assert_eq!(d.text, "Hasło: zażółć\n");
    }

    #[test]
    fn boms_are_recognised_and_kept() {
        let mut utf8 = UTF8_BOM.to_vec();
        utf8.extend_from_slice("żółw\n".as_bytes());
        let d = decode(&utf8, true).unwrap();
        assert_eq!(d.encoding, TextEncoding::Utf8 { bom: true });
        assert_eq!(d.text, "żółw\n", "the BOM is not part of the text");
        assert_eq!(encode(&d.text, d.encoding).unwrap(), utf8);

        for (enc, bom) in [
            (TextEncoding::Utf16Le, UTF16LE_BOM),
            (TextEncoding::Utf16Be, UTF16BE_BOM),
        ] {
            let bytes = encode("żółw\r\nline\r\n", enc).unwrap();
            assert!(bytes.starts_with(bom));
            let d = decode(&bytes, true).expect("UTF-16 is text, despite its NUL bytes");
            assert_eq!(d.encoding, enc);
            assert!(d.lossless);
            assert_eq!(d.text, "żółw\r\nline\r\n");
        }
    }

    #[test]
    fn nul_without_a_bom_is_binary() {
        assert!(decode(b"PK\x03\x04\x00\x00", true).is_none());
        // UTF-32LE starts with the UTF-16LE mark; it decodes to NULs.
        assert!(decode(b"\xFF\xFE\x00\x00a\x00\x00\x00", true).is_none());
    }

    #[test]
    fn a_character_the_encoding_lacks_is_refused_not_replaced() {
        let e = TextEncoding::Legacy(WINDOWS_1250);
        assert_eq!(encode("zażółć", e).unwrap(), cp1250("zażółć"));
        let missing = encode("a → b → 😀", e).unwrap_err();
        assert_eq!(missing, vec!['→', '😀']);
    }

    #[test]
    fn a_utf8_sample_cut_mid_character_is_still_utf8() {
        let bytes = "ab€".as_bytes();
        let cut = &bytes[..bytes.len() - 1];
        assert_eq!(detect(cut, false), Some(TextEncoding::Utf8 { bom: false }));
        // …but a complete file that ends that way is not valid UTF-8.
        assert!(matches!(detect(cut, true), Some(TextEncoding::Legacy(_))));
    }

    #[test]
    fn a_file_that_does_not_decode_cleanly_is_marked_lossy() {
        // A UTF-8 BOM followed by bytes that aren't UTF-8.
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"caf\xE9\n");
        let d = decode(&bytes, true).unwrap();
        assert!(!d.lossless);
        assert!(d.text.contains('\u{FFFD}'));
    }
}
