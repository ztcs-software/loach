//! Built-in `count` tool — exact character / byte / word / line / substring
//! counts. Models tokenize text into BPE units, which hides character
//! identity (and counts) from them — the canonical "how many r's in
//! strawberry" failure. This tool just delegates to the standard library.

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "count";

/// Guard against truly pathological inputs. 1 MiB of chat input is well
/// beyond anything a user would paste in conversation, but well below
/// any limit the model's own context already enforces.
const MAX_INPUT_BYTES: usize = 1024 * 1024;

pub fn tool_description() -> &'static str {
    "Count characters, bytes, words, lines, or occurrences of a substring \
     in a string. Use this rather than estimating — tokenization hides the \
     actual character count from you, and you will be wrong even on simple \
     inputs like `strawberry`. Modes: \
     `chars` (Unicode scalar values), \
     `bytes` (UTF-8 byte length), \
     `words` (whitespace-separated tokens), \
     `lines` (count of `\\n`-separated lines, treating the final unterminated \
     line as a line), \
     `occurrences` (non-overlapping count of `needle` in `input`)."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "string", "description": "The string to count in." },
            "mode": {
                "type": "string",
                "enum": ["chars", "bytes", "words", "lines", "occurrences"],
                "description": "What to count."
            },
            "needle": { "type": "string", "description": "Substring to count for `occurrences`. Required in that mode." },
            "case_sensitive": { "type": "boolean", "description": "For `occurrences` only. Default true." }
        },
        "required": ["input", "mode"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let input = match args.get("input").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `input` argument (string)"),
    };
    if input.len() > MAX_INPUT_BYTES {
        return err(format!(
            "input is {} bytes; max is {MAX_INPUT_BYTES}",
            input.len()
        ));
    }
    let mode = match args.get("mode").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `mode` argument"),
    };
    let n = match mode {
        "chars" => input.chars().count(),
        "bytes" => input.len(),
        "words" => input.split_whitespace().count(),
        // `lines()` consumes one trailing `\n` if present and treats the
        // final unterminated line as a line. That matches what users mean
        // by "how many lines" — `wc -l` would give a different answer for
        // unterminated files but that's a tool-specific quirk, not what
        // the model is being asked.
        "lines" => input.lines().count(),
        "occurrences" => {
            let needle = match args.get("needle").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s,
                Some(_) => return err("`needle` must be non-empty for occurrences"),
                None => return err("missing required `needle` argument for occurrences"),
            };
            let case_sensitive = args
                .get("case_sensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if case_sensitive {
                input.matches(needle).count()
            } else {
                input.to_lowercase().matches(&needle.to_lowercase()).count()
            }
        }
        other => return err(format!("unknown mode `{other}`")),
    };
    McpCallResult {
        content_text: n.to_string(),
        is_error: false,
    }
}

fn err(msg: impl Into<String>) -> McpCallResult {
    McpCallResult {
        content_text: msg.into(),
        is_error: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_chars_correctly_for_strawberry() {
        // The canonical model-failure prompt.
        let r = dispatch(&json!({"input": "strawberry", "mode": "occurrences", "needle": "r"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "3");
    }

    #[test]
    fn chars_vs_bytes_for_multibyte_input() {
        let r = dispatch(&json!({"input": "naïve", "mode": "chars"}));
        assert_eq!(r.content_text, "5");
        let r = dispatch(&json!({"input": "naïve", "mode": "bytes"}));
        // ï is 2 bytes in UTF-8, so 5 chars = 6 bytes.
        assert_eq!(r.content_text, "6");
    }

    #[test]
    fn counts_words_and_lines() {
        let r = dispatch(&json!({"input": "one two\nthree four", "mode": "words"}));
        assert_eq!(r.content_text, "4");
        let r = dispatch(&json!({"input": "one\ntwo\nthree", "mode": "lines"}));
        assert_eq!(r.content_text, "3");
    }

    #[test]
    fn occurrences_are_non_overlapping() {
        let r = dispatch(&json!({"input": "aaaa", "mode": "occurrences", "needle": "aa"}));
        // Standard non-overlapping count: "aaaa" contains "aa" twice.
        assert_eq!(r.content_text, "2");
    }

    #[test]
    fn case_insensitive_occurrences() {
        let r = dispatch(&json!({
            "input": "Foo foo FOO", "mode": "occurrences", "needle": "foo", "case_sensitive": false,
        }));
        assert_eq!(r.content_text, "3");
    }

    #[test]
    fn rejects_unknown_mode() {
        let r = dispatch(&json!({"input": "x", "mode": "vowels"}));
        assert!(r.is_error);
    }

    #[test]
    fn rejects_empty_needle() {
        let r = dispatch(&json!({"input": "x", "mode": "occurrences", "needle": ""}));
        assert!(r.is_error);
    }
}
