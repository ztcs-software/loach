//! Built-in `json` tool — format, validate, or extract from JSON.
//!
//! Models routinely produce JSON that is *almost* valid (trailing commas,
//! unescaped quotes, smart quotes from a Word paste). They also try to
//! eyeball a deep path and miss. `serde_json` is already a dependency, so
//! this is essentially free.
//!
//! `extract` uses JSON Pointer (RFC 6901), not JSONPath, to avoid pulling
//! another crate. Syntax: `/foo/bar/0` — leading slash, slash-separated,
//! integer indices for arrays. Documented in the description.

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "json";

/// 4 MiB cap. Same rationale as the other text tools.
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

pub fn tool_description() -> &'static str {
    "Validate, pretty-print, or extract a value from JSON. Use this when \
     you're unsure whether a string is valid JSON, when you need a clean \
     indented copy, or when you want a specific nested value. Operations: \
     `validate` (returns `valid` or a parse error with line/column), \
     `format` (pretty-prints with `indent` spaces, default 2 — also \
     validates as a side effect), \
     `extract` (returns the value at a JSON Pointer path, RFC 6901, e.g. \
     `/users/0/name`; leading slash, slash-separated, integer indices for \
     arrays, `~1` escapes `/`, `~0` escapes `~`). `format` and `extract` \
     keep key order but re-write numbers as 64-bit values: an integer \
     beyond the 64-bit range, or a decimal with more than ~17 significant \
     digits, comes back rounded."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "string", "description": "The JSON text." },
            "op": {
                "type": "string",
                "enum": ["validate", "format", "extract"],
                "description": "Operation to perform."
            },
            "path": { "type": "string", "description": "JSON Pointer for `extract` (e.g. `/users/0/name`). Empty pointer (`\"\"`) returns the root." },
            "indent": { "type": "integer", "minimum": 0, "maximum": 8, "description": "Indent for `format`. Defaults to 2." }
        },
        "required": ["input", "op"],
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
    let op = match args.get("op").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `op` argument"),
    };
    match op {
        "validate" => match serde_json::from_str::<Value>(input) {
            Ok(_) => ok("valid"),
            Err(e) => err(format!("invalid JSON at line {} column {}: {e}", e.line(), e.column())),
        },
        "format" => {
            let parsed: Value = match serde_json::from_str(input) {
                Ok(v) => v,
                Err(e) => return err(format!("invalid JSON at line {} column {}: {e}", e.line(), e.column())),
            };
            // Clamp at the schema's documented max of 8. The schema declares
            // `maximum: 8` but Tauri does not enforce JSON-Schema at the IPC
            // boundary, so a model that ignores the schema could otherwise
            // pass `indent: 1_000_000` and allocate a 1 MiB indent string.
            // `lenient_i64` so a float-shaped `4.0` counts rather than
            // falling back to the default unnoticed.
            let indent = crate::tools::lenient_i64(args, "indent")
                .and_then(|n| u64::try_from(n).ok())
                .unwrap_or(2)
                .min(8);
            // serde_json::to_string_pretty hard-codes 2-space indent, so
            // we build a formatter when the user asks for something else.
            let out = if indent == 2 {
                serde_json::to_string_pretty(&parsed)
                    .unwrap_or_else(|e| format!("formatting failed: {e}"))
            } else {
                let mut buf = Vec::new();
                let indent_str: String = " ".repeat(indent as usize);
                let formatter = serde_json::ser::PrettyFormatter::with_indent(indent_str.as_bytes());
                let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
                if let Err(e) = serde::Serialize::serialize(&parsed, &mut ser) {
                    return err(format!("formatting failed: {e}"));
                }
                String::from_utf8(buf).unwrap_or_else(|_| "non-UTF-8 output".to_string())
            };
            ok(out)
        }
        "extract" => {
            let path = match args.get("path").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return err("missing required `path` argument for extract"),
            };
            let parsed: Value = match serde_json::from_str(input) {
                Ok(v) => v,
                Err(e) => return err(format!("invalid JSON at line {} column {}: {e}", e.line(), e.column())),
            };
            // A pointer starts with `/`; `users/0/name` is one with the slash
            // forgotten, so read it as meant rather than report it missing.
            let pointer = if path.is_empty() || path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            };
            match parsed.pointer(&pointer) {
                Some(v) => ok(
                    serde_json::to_string_pretty(v)
                        .unwrap_or_else(|e| format!("formatting failed: {e}")),
                ),
                // JSONPath (`$.users[0].name`) finds nothing as a pointer, and
                // "no value" would read as a missing key.
                None if path.starts_with('$') || path.contains('[') => err(format!(
                    "`{path}` looks like JSONPath; this tool takes a JSON Pointer \
                     instead — `$.users[0].name` is `/users/0/name`"
                )),
                None => err(format!("no value found at JSON Pointer `{pointer}`")),
            }
        }
        other => err(format!("unknown op `{other}`")),
    }
}

fn ok(s: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: s.into(),
        is_error: false,
        ..Default::default()
    }
}

fn err(s: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: s.into(),
        is_error: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_accepts_valid_json() {
        let r = dispatch(&json!({"input": r#"{"a":1}"#, "op": "validate"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "valid");
    }

    #[test]
    fn validate_rejects_trailing_comma() {
        let r = dispatch(&json!({"input": r#"{"a":1,}"#, "op": "validate"}));
        assert!(r.is_error);
        assert!(r.content_text.contains("line") && r.content_text.contains("column"));
    }

    #[test]
    fn format_pretty_prints() {
        let r = dispatch(&json!({"input": r#"{"a":1,"b":[2,3]}"#, "op": "format"}));
        assert!(!r.is_error);
        // 2-space indent, key on its own line.
        assert!(r.content_text.contains("\n  \"a\": 1"));
    }

    #[test]
    fn format_respects_indent() {
        let r = dispatch(&json!({"input": r#"{"a":1}"#, "op": "format", "indent": 4}));
        assert!(!r.is_error);
        assert!(r.content_text.contains("\n    \"a\""));
    }

    /// Keys come back in the order the model wrote them; without serde_json's
    /// `preserve_order` they were re-sorted alphabetically.
    #[test]
    fn format_and_extract_keep_key_order() {
        let input = r#"{"zeta":1,"alpha":{"y":2,"b":3},"mid":[{"k2":0,"k1":0}]}"#;
        let r = dispatch(&json!({"input": input, "op": "format", "indent": 0}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text.replace('\n', ""), input.replace(':', ": "));
        let r = dispatch(&json!({"input": input, "op": "extract", "path": "/alpha"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "{\n  \"y\": 2,\n  \"b\": 3\n}");
    }

    #[test]
    fn extract_walks_path() {
        let r = dispatch(&json!({
            "input": r#"{"users":[{"name":"Ada"},{"name":"Linus"}]}"#,
            "op": "extract",
            "path": "/users/1/name",
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "\"Linus\"");
    }

    #[test]
    fn extract_empty_path_returns_root() {
        let r = dispatch(&json!({"input": "[1,2,3]", "op": "extract", "path": ""}));
        assert!(!r.is_error);
        assert!(r.content_text.contains("1"));
        assert!(r.content_text.contains("3"));
    }

    #[test]
    fn extract_missing_path_is_error() {
        let r = dispatch(&json!({"input": r#"{"a":1}"#, "op": "extract", "path": "/missing"}));
        assert!(r.is_error);
    }

    #[test]
    fn extract_reads_a_path_missing_its_leading_slash() {
        let input = r#"{"users":[{"name":"Ada"}]}"#;
        let r = dispatch(&json!({"input": input, "op": "extract", "path": "users/0/name"}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text, "\"Ada\"");
        let r = dispatch(&json!({"input": input, "op": "extract", "path": "users/1"}));
        assert!(r.is_error);
        assert!(r.content_text.contains("`/users/1`"), "{}", r.content_text);
    }

    #[test]
    fn extract_points_jsonpath_at_pointer_syntax() {
        let input = r#"{"users":[{"name":"Ada"}]}"#;
        for path in ["$.users[0].name", "users[0]"] {
            let r = dispatch(&json!({"input": input, "op": "extract", "path": path}));
            assert!(r.is_error, "{path}");
            assert!(r.content_text.contains("JSONPath"), "{path}: {}", r.content_text);
        }
    }

    #[test]
    fn format_accepts_a_float_shaped_indent() {
        let r = dispatch(&json!({"input": r#"{"a":1}"#, "op": "format", "indent": 4.0}));
        assert!(!r.is_error);
        assert!(r.content_text.contains("\n    \"a\""), "{}", r.content_text);
    }
}
