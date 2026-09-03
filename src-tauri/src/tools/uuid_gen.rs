//! Built-in `uuid` tool — generate v4 (random) or v7 (time-ordered) UUIDs.
//!
//! Models will produce a UUID-shaped string on demand but the bits in
//! the middle are just hallucinated. Anyone who pastes that into a DB
//! will eventually hit a collision with another hallucination. This
//! tool calls the actual `uuid` crate so the output is genuinely random
//! (v4) or genuinely time-ordered (v7).

use serde_json::{json, Value};
use uuid::Uuid;

use crate::mcp::McpCallResult;

pub const TOOL_NAME: &str = "uuid";

/// Caps how many UUIDs a single call can mint. Any sane use is one or
/// a handful; the cap exists so a runaway prompt can't ask for 10
/// million and feed them all back through the model's context.
const MAX_COUNT: u32 = 100;

pub fn tool_description() -> &'static str {
    "Generate one or more UUIDs. Use this rather than typing UUID-shaped \
     strings in by hand — your bits would just be hallucinated and would \
     eventually collide. Versions: `v4` (random, default) and `v7` \
     (time-ordered, monotonically increasing — good for DB primary keys \
     because it preserves insertion order). `count` mints multiple UUIDs \
     in one call (max 100), one per line."
}

pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "version": {
                "type": "string",
                "enum": ["v4", "v7"],
                "description": "UUID version. Defaults to v4."
            },
            "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_COUNT,
                "description": "How many UUIDs to generate. Defaults to 1, max 100."
            }
        },
        "additionalProperties": false
    })
}

pub fn dispatch(args: &Value) -> McpCallResult {
    let version = args.get("version").and_then(|v| v.as_str()).unwrap_or("v4");
    let count = crate::tools::lenient_i64(args, "count").unwrap_or(1);
    if count < 1 {
        return err("`count` must be at least 1");
    }
    if count > MAX_COUNT as i64 {
        return err(format!("`count` is {count}; max is {MAX_COUNT}"));
    }
    let gen_one: fn() -> Uuid = match version {
        "v4" => Uuid::new_v4,
        "v7" => Uuid::now_v7,
        other => return err(format!("unknown version `{other}` — use v4 or v7")),
    };
    let lines: Vec<String> = (0..count).map(|_| gen_one().to_string()).collect();
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
    fn count_accepts_float_shaped_integers() {
        // `count: 5.0` used to fail `as_u64`, fall back to the default, and
        // silently emit a single UUID.
        let r = dispatch(&json!({"count": 5.0}));
        assert!(!r.is_error, "{}", r.content_text);
        assert_eq!(r.content_text.lines().count(), 5);
    }

    #[test]
    fn default_generates_one_v4() {
        let r = dispatch(&json!({}));
        assert!(!r.is_error);
        let parsed = Uuid::parse_str(r.content_text.trim()).expect("emits a parseable uuid");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn count_generates_n_unique() {
        let r = dispatch(&json!({"count": 5}));
        assert!(!r.is_error);
        let lines: Vec<&str> = r.content_text.lines().collect();
        assert_eq!(lines.len(), 5);
        // v4 collisions are astronomically unlikely in 5 draws — if this
        // ever fires, we have a bigger problem than the test failing.
        let unique: std::collections::HashSet<&&str> = lines.iter().collect();
        assert_eq!(unique.len(), 5);
    }

    #[test]
    fn v7_is_time_ordered() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        // v7 puts the unix-ms timestamp in the top 48 bits, so successive
        // calls produce non-decreasing values within the same instant
        // and strictly increasing across instants. We don't sleep here;
        // tied timestamps are fine because the random tail still orders
        // deterministically per-call.
        assert!(b >= a, "expected b ({b}) >= a ({a})");
        assert_eq!(b.get_version_num(), 7);
    }

    #[test]
    fn rejects_overlarge_count() {
        let r = dispatch(&json!({"count": MAX_COUNT as u64 + 1}));
        assert!(r.is_error);
    }

    #[test]
    fn rejects_unknown_version() {
        let r = dispatch(&json!({"version": "v6"}));
        assert!(r.is_error);
    }
}
