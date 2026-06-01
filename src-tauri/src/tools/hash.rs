//! Built-in `hash` tool — exact SHA-2 digests over arbitrary input.
//!
//! Models will cheerfully fabricate a SHA-256 that looks plausible but
//! is just made up. SHA-1 and MD5 are intentionally not exposed: they
//! are broken for cryptographic use and we'd rather not encourage them.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "hash";

/// 4 MiB input cap. Larger blobs aren't realistic in a chat prompt and
/// the model would be paying for them in context tokens anyway.
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

pub fn tool_description() -> &'static str {
    "Compute a SHA-2 hash of a string. Use this rather than guessing a \
     digest — your answer would just be a hallucination of the right \
     shape. Algorithms: `sha224`, `sha256` (default), `sha384`, `sha512`. \
     `input_format` controls how `input` is interpreted before hashing: \
     `utf8` (default), `hex` (decode a hex string), `base64` (decode a \
     standard base64 string). Output is lowercase hex of the digest."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "string", "description": "Data to hash." },
            "algorithm": {
                "type": "string",
                "enum": ["sha224", "sha256", "sha384", "sha512"],
                "description": "Hash algorithm. Defaults to sha256."
            },
            "input_format": {
                "type": "string",
                "enum": ["utf8", "hex", "base64"],
                "description": "How to interpret `input`. Defaults to utf8."
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
    let algo = args
        .get("algorithm")
        .and_then(|v| v.as_str())
        .unwrap_or("sha256");
    let fmt = args
        .get("input_format")
        .and_then(|v| v.as_str())
        .unwrap_or("utf8");
    let bytes = match decode_input(input, fmt) {
        Ok(b) => b,
        Err(e) => return err(e),
    };
    let digest_hex = match algo {
        "sha224" => hex(Sha224::digest(&bytes).as_slice()),
        "sha256" => hex(Sha256::digest(&bytes).as_slice()),
        "sha384" => hex(Sha384::digest(&bytes).as_slice()),
        "sha512" => hex(Sha512::digest(&bytes).as_slice()),
        other => return err(format!("unknown algorithm `{other}` — use sha224/sha256/sha384/sha512")),
    };
    McpCallResult {
        content_text: digest_hex,
        is_error: false,
        ..Default::default()
    }
}

fn decode_input(input: &str, fmt: &str) -> Result<Vec<u8>, String> {
    match fmt {
        "utf8" => Ok(input.as_bytes().to_vec()),
        "hex" => {
            let cleaned: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            // Reject non-ASCII before the byte-index slicing below. `cleaned`
            // is built by filtering `chars()`, so a retained multi-byte char
            // (e.g. `中`) would otherwise make `&cleaned[i..i + 2]` slice mid-
            // character and panic ("byte index N is not a char boundary").
            // Hex digits are ASCII by definition, so anything else is invalid
            // input, not a crash.
            if !cleaned.is_ascii() {
                return Err("hex input must contain only ASCII hex digits".to_string());
            }
            if cleaned.len() % 2 != 0 {
                return Err("hex input has an odd number of characters".to_string());
            }
            (0..cleaned.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
                .map_err(|e| format!("invalid hex input: {e}"))
        }
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(input.trim())
            .map_err(|e| format!("invalid base64 input: {e}")),
        other => Err(format!("unknown input_format `{other}` — use utf8/hex/base64")),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // {:02x} is two lowercase hex digits, zero-padded.
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
    fn sha256_of_empty_string_is_known() {
        // SHA-256 of "" is well-known; checks the wire-up.
        let r = dispatch(&json!({"input": "", "algorithm": "sha256"}));
        assert!(!r.is_error);
        assert_eq!(
            r.content_text,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn defaults_to_sha256() {
        let r = dispatch(&json!({"input": "abc"}));
        assert!(!r.is_error);
        assert_eq!(
            r.content_text,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha512_round_trip() {
        let r = dispatch(&json!({"input": "abc", "algorithm": "sha512"}));
        assert!(!r.is_error);
        // First 16 hex chars of SHA-512("abc"); pinning a prefix is enough
        // to confirm we're calling the right digest, without a 128-char
        // string literal in the source.
        assert!(r.content_text.starts_with("ddaf35a193617aba"));
        assert_eq!(r.content_text.len(), 128);
    }

    #[test]
    fn hex_input_format_decodes() {
        // SHA-256 over a single zero byte.
        let r = dispatch(&json!({"input": "00", "input_format": "hex"}));
        assert!(!r.is_error);
        assert_eq!(
            r.content_text,
            "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"
        );
    }

    #[test]
    fn rejects_bad_algorithm() {
        let r = dispatch(&json!({"input": "x", "algorithm": "md5"}));
        assert!(r.is_error);
    }
}
