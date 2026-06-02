//! Built-in `base64` tool — encode/decode strings with the standard or
//! URL-safe alphabet. Models routinely garble padding or mix alphabets;
//! `base64` is a few lines, so we just do it ourselves.

use base64::Engine;
use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "base64";

/// 4 MiB cap — same rationale as `hash`. Bigger blobs aren't realistic
/// for in-chat operations.
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

pub fn tool_description() -> &'static str {
    "Encode a UTF-8 string to base64, or decode a base64 string to UTF-8 \
     (returning the bytes as hex if the result isn't valid UTF-8). Modes: \
     `encode` (default), `decode`. Alphabets: `standard` (default, RFC 4648 \
     §4 with `+` and `/`) or `url_safe` (RFC 4648 §5 with `-` and `_`). \
     Padding (`=`) is added on encode and accepted-but-not-required on decode."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "string", "description": "The string to encode or decode." },
            "op": {
                "type": "string",
                "enum": ["encode", "decode"],
                "description": "Operation. Defaults to encode."
            },
            "alphabet": {
                "type": "string",
                "enum": ["standard", "url_safe"],
                "description": "Alphabet variant. Defaults to standard."
            }
        },
        "required": ["input"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let input = match args.get("input").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `input` argument (string)"),
    };
    if input.len() > MAX_INPUT_BYTES {
        return err(format!("input is {} bytes; max is {MAX_INPUT_BYTES}", input.len()));
    }
    let op = args.get("op").and_then(|v| v.as_str()).unwrap_or("encode");
    let alphabet = args
        .get("alphabet")
        .and_then(|v| v.as_str())
        .unwrap_or("standard");
    // Decoders accept padded *or* unpadded input — the variant choice
    // here only matters for encode (which always emits padding) and for
    // which alphabet's lookup table to use.
    let engine = match alphabet {
        "standard" => &base64::engine::general_purpose::STANDARD,
        "url_safe" => &base64::engine::general_purpose::URL_SAFE,
        other => return err(format!("unknown alphabet `{other}` — use standard or url_safe")),
    };
    match op {
        "encode" => McpCallResult {
            content_text: engine.encode(input.as_bytes()),
            is_error: false,
            ..Default::default()
        },
        "decode" => {
            // Be permissive about missing padding — match the convention
            // most user-facing base64 tools (incl. `python -m base64`) use.
            let decoded = match engine.decode(input.trim()) {
                Ok(bytes) => bytes,
                Err(_) => {
                    let lenient = match alphabet {
                        "url_safe" => &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                        _ => &base64::engine::general_purpose::STANDARD_NO_PAD,
                    };
                    match lenient.decode(input.trim()) {
                        Ok(b) => b,
                        Err(e) => return err(format!("invalid base64 input: {e}")),
                    }
                }
            };
            McpCallResult {
                content_text: match String::from_utf8(decoded.clone()) {
                    Ok(s) => s,
                    // Non-UTF-8 result: hex-dump it so the model still has
                    // something deterministic to read.
                    Err(_) => format!("(non-UTF-8 bytes, hex) {}", hex(&decoded)),
                },
                is_error: false,
                ..Default::default()
            }
        }
        other => err(format!("unknown op `{other}` — use encode or decode")),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_ascii() {
        let r = dispatch(&json!({"input": "hello world"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "aGVsbG8gd29ybGQ=");
        let r = dispatch(&json!({"input": &r.content_text, "op": "decode"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "hello world");
    }

    #[test]
    fn url_safe_alphabet_uses_dash_underscore() {
        // 0xff_fe_fd in url-safe alphabet encodes with `-`/`_`, not `+`/`/`.
        let r = dispatch(&json!({
            "input": "\u{00ff}\u{00fe}\u{00fd}",
            "alphabet": "url_safe",
        }));
        // We're not pinning the exact ciphertext — UTF-8 of those code
        // points isn't just three bytes — but the alphabet check is the
        // assertion that matters.
        assert!(!r.is_error);
        assert!(!r.content_text.contains('+'));
        assert!(!r.content_text.contains('/'));
    }

    #[test]
    fn decode_accepts_missing_padding() {
        // "hello" → "aGVsbG8=" with padding; "aGVsbG8" without.
        let r = dispatch(&json!({"input": "aGVsbG8", "op": "decode"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "hello");
    }

    #[test]
    fn rejects_garbage_input() {
        let r = dispatch(&json!({"input": "@@@@", "op": "decode"}));
        assert!(r.is_error);
    }
}
