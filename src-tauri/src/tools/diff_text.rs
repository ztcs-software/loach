//! Built-in `diff_text` tool — unified diff between two strings.
//!
//! Models try to eyeball diffs and miss small changes in longer inputs
//! (e.g. a single character flip in a hundred-line config). `similar`
//! is the de facto Rust line/word-diff implementation; this just wraps it.

use serde_json::{json, Value};
use similar::{ChangeTag, TextDiff};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "diff_text";

/// Per-side input cap. 512 KiB is well over what fits in a chat turn and
/// keeps the O(n·m) Myers-style diff bounded enough that the model
/// stays responsive even on adversarial inputs.
const MAX_INPUT_BYTES: usize = 512 * 1024;

pub fn tool_description() -> &'static str {
    "Compute a unified diff between two strings. Use this rather than \
     eyeballing — even small changes in long inputs are easy to miss. \
     Modes: `line` (default — diff by line, suitable for code and config), \
     `word` (diff by whitespace-separated word, suitable for prose), \
     `char` (diff by Unicode character, suitable for short strings). \
     The output is unified-diff text with `-` for `a`-only, `+` for \
     `b`-only, ` ` for shared. `context` controls the number of \
     surrounding context lines (default 3, set to a large number to \
     show the whole file)."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "a": { "type": "string", "description": "Old / left-hand text." },
            "b": { "type": "string", "description": "New / right-hand text." },
            "mode": {
                "type": "string",
                "enum": ["line", "word", "char"],
                "description": "Diff granularity. Defaults to line."
            },
            "context": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1000,
                "description": "Context lines around each hunk (line mode). Default 3."
            }
        },
        "required": ["a", "b"],
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let a = match args.get("a").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `a` argument (string)"),
    };
    let b = match args.get("b").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return err("missing required `b` argument (string)"),
    };
    if a.len() > MAX_INPUT_BYTES || b.len() > MAX_INPUT_BYTES {
        return err(format!(
            "input too long (max {MAX_INPUT_BYTES} bytes per side)"
        ));
    }
    let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("line");
    let context = args
        .get("context")
        .and_then(|v| v.as_u64())
        .unwrap_or(3)
        .min(1000) as usize;
    let out = match mode {
        "line" => unified_lines(a, b, context),
        "word" => inline_diff(TextDiff::from_words(a, b)),
        "char" => inline_diff(TextDiff::from_chars(a, b)),
        other => return err(format!("unknown mode `{other}`")),
    };
    if out.trim().is_empty() {
        return McpCallResult {
            content_text: "(no differences)".to_string(),
            is_error: false,
            ..Default::default()
        };
    }
    McpCallResult {
        content_text: out,
        is_error: false,
        ..Default::default()
    }
}

fn unified_lines(a: &str, b: &str, context: usize) -> String {
    let diff = TextDiff::from_lines(a, b);
    diff.unified_diff()
        .context_radius(context)
        .header("a", "b")
        .to_string()
}

/// For word/char diffs, `similar`'s `unified_diff` is awkward — the
/// concept of "lines" doesn't translate cleanly. Render an inline,
/// `[+added+][-removed-]` style that's still copy-pasteable. (The
/// brackets prevent ambiguity when the change itself contains spaces.)
fn inline_diff<'a>(diff: TextDiff<'a, 'a, 'a, str>) -> String {
    let mut out = String::new();
    for change in diff.iter_all_changes() {
        let s = change.value();
        match change.tag() {
            ChangeTag::Equal => out.push_str(s),
            ChangeTag::Insert => {
                out.push_str("[+");
                out.push_str(s);
                out.push_str("+]");
            }
            ChangeTag::Delete => {
                out.push_str("[-");
                out.push_str(s);
                out.push_str("-]");
            }
        }
    }
    out
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
    fn line_diff_shows_changed_line() {
        let r = dispatch(&json!({
            "a": "alpha\nbeta\ngamma\n",
            "b": "alpha\nBETA\ngamma\n",
        }));
        assert!(!r.is_error);
        assert!(r.content_text.contains("-beta"));
        assert!(r.content_text.contains("+BETA"));
    }

    #[test]
    fn identical_inputs_report_no_differences() {
        let r = dispatch(&json!({"a": "same\nstuff\n", "b": "same\nstuff\n"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "(no differences)");
    }

    #[test]
    fn word_diff_inline() {
        let r = dispatch(&json!({
            "a": "the quick brown fox",
            "b": "the slow brown fox",
            "mode": "word",
        }));
        assert!(!r.is_error, "{}", r.content_text);
        assert!(r.content_text.contains("[-quick-]"));
        assert!(r.content_text.contains("[+slow+]"));
    }

    #[test]
    fn char_diff_inline() {
        let r = dispatch(&json!({"a": "cat", "b": "cot", "mode": "char"}));
        assert!(!r.is_error);
        assert!(r.content_text.contains("[-a-]"));
        assert!(r.content_text.contains("[+o+]"));
    }

    #[test]
    fn rejects_unknown_mode() {
        let r = dispatch(&json!({"a": "x", "b": "y", "mode": "patch"}));
        assert!(r.is_error);
    }
}
