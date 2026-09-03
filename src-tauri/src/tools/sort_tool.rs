//! Built-in `sort` tool — lexical, natural, or numeric line sort.
//!
//! Models often produce `file1, file10, file2` order when the user
//! clearly wanted `file1, file2, file10`. `natord` exists for exactly
//! this case. The other modes are just for completeness so the model
//! has one tool to reach for instead of three.

use serde_json::{json, Value};

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "sort";

/// 1 MiB cap on the joined input. Sorting beyond that lives in `sort(1)`,
/// not in a chat tool.
const MAX_INPUT_BYTES: usize = 1024 * 1024;

pub fn tool_description() -> &'static str {
    "Sort lines of text. Use this rather than reordering by hand — natural \
     sort especially is easy to get wrong (`file1, file2, file10` not \
     `file1, file10, file2`). Modes: \
     `lexical` (default — byte-wise comparison, fastest, Unicode-aware in \
     Rust), \
     `natural` (treats runs of digits as numbers — `file2` before `file10`), \
     `numeric` (parses each line as a number and sorts numerically — lines \
     that don't parse sort after the numbers in their original order). \
     Flags: `reverse` (descending order), `unique` (collapse adjacent \
     duplicates after sort, like `sort -u`), `case_sensitive` (default true; \
     when false, lexical and natural compare case-insensitively)."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": { "type": "string", "description": "Newline-separated lines to sort." },
            "mode": {
                "type": "string",
                "enum": ["lexical", "natural", "numeric"],
                "description": "Sort mode. Defaults to lexical."
            },
            "reverse": { "type": "boolean", "description": "Descending order. Default false." },
            "unique": { "type": "boolean", "description": "Drop adjacent duplicates after sort. Default false." },
            "case_sensitive": { "type": "boolean", "description": "Default true. Ignored in numeric mode." }
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
    let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("lexical");
    let reverse = args.get("reverse").and_then(|v| v.as_bool()).unwrap_or(false);
    let unique = args.get("unique").and_then(|v| v.as_bool()).unwrap_or(false);
    let case_sensitive = args
        .get("case_sensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let mut lines: Vec<String> = input.lines().map(|s| s.to_string()).collect();
    match mode {
        "lexical" => {
            if case_sensitive {
                lines.sort();
            } else {
                // `sort_by_key` lowercases each line once and caches the key
                // — `sort_by` would re-lowercase both sides on every
                // comparison (O(n log n) extra allocations). Same observable
                // ordering either way.
                lines.sort_by_key(|a| a.to_lowercase());
            }
        }
        "natural" => {
            if case_sensitive {
                lines.sort_by(|a, b| natord::compare(a, b));
            } else {
                lines.sort_by(|a, b| natord::compare_ignore_case(a, b));
            }
        }
        "numeric" => {
            // Pair each line with its parsed value (if any) and sort. Lines
            // that don't parse are pushed to the back in their original
            // order so the model still gets every line back.
            //
            // NaN is treated as unparseable even though `parse` accepts it:
            // it compares unequal to everything, so admitting it makes the
            // comparator non-transitive — which left the whole list unsorted
            // (and could trip the standard sort's order-violation panic).
            // "NaN" shows up in real data columns, so this is reachable.
            let mut decorated: Vec<(usize, Option<f64>, String)> = lines
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    let n = l.trim().parse::<f64>().ok().filter(|v| !v.is_nan());
                    (i, n, l.clone())
                })
                .collect();
            decorated.sort_by(|a, b| match (a.1, b.1) {
                (Some(x), Some(y)) => x.total_cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.0.cmp(&b.0),
            });
            lines = decorated.into_iter().map(|(_, _, s)| s).collect();
        }
        other => return err(format!("unknown mode `{other}`")),
    }
    if reverse {
        lines.reverse();
    }
    if unique {
        lines.dedup();
    }
    McpCallResult {
        content_text: lines.join("\n"),
        is_error: false,
        ..Default::default()
    }
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
    fn natural_sort_orders_numbers_correctly() {
        let r = dispatch(&json!({
            "input": "file10\nfile1\nfile2",
            "mode": "natural",
        }));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "file1\nfile2\nfile10");
    }

    #[test]
    fn lexical_sort_is_byte_order() {
        let r = dispatch(&json!({"input": "file10\nfile1\nfile2"}));
        assert!(!r.is_error);
        // Byte order: '1' < '2', so file10 sorts before file2.
        assert_eq!(r.content_text, "file1\nfile10\nfile2");
    }

    #[test]
    fn numeric_sort_orders_by_value() {
        let r = dispatch(&json!({"input": "10\n2\n1.5", "mode": "numeric"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "1.5\n2\n10");
    }

    #[test]
    fn numeric_sort_treats_nan_as_unparseable() {
        // `"nan".parse::<f64>()` succeeds, and NaN compares unequal to
        // everything — admitting it made the comparator non-transitive and
        // left the whole list in input order.
        let r = dispatch(&json!({"input": "200\nnan\n199\nnan\n198", "mode": "numeric"}));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "198\n199\n200\nnan\nnan");
    }

    #[test]
    fn reverse_flips_order() {
        let r = dispatch(&json!({
            "input": "a\nb\nc",
            "reverse": true,
        }));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "c\nb\na");
    }

    #[test]
    fn unique_drops_adjacent_duplicates() {
        let r = dispatch(&json!({
            "input": "a\nb\na\nb",
            "unique": true,
        }));
        assert!(!r.is_error);
        // After sort: a a b b → dedup → a b.
        assert_eq!(r.content_text, "a\nb");
    }

    #[test]
    fn case_insensitive_lexical() {
        let r = dispatch(&json!({
            "input": "Banana\napple\ncherry",
            "case_sensitive": false,
        }));
        assert!(!r.is_error);
        assert_eq!(r.content_text, "apple\nBanana\ncherry");
    }

    #[test]
    fn rejects_unknown_mode() {
        let r = dispatch(&json!({"input": "a\nb", "mode": "alphabet"}));
        assert!(r.is_error);
    }
}
