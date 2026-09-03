//! Backend "tools" that augment a chat with out-of-band capabilities.
//!
//! Two flavours live here:
//! * [`fetch_url`] — user-driven URL prefetcher. The frontend scans the
//!   user message, calls `fetch_url` for each link, and inlines the
//!   returned text into the outgoing prompt before streaming starts.
//!   The model doesn't get to *decide* to fetch.
//! * Model-driven built-ins (`calculate`, `datetime`, `count`, …) —
//!   exposed to the model alongside MCP tools when their per-tool toggle
//!   in Settings → Tools is on. The model calls them via `tools/call`
//!   and the answer flows back through the standard tool-result path.
//!   [`builtin`] is the registry every built-in is registered in; it's
//!   the only thing `commands::chat_stream` and `mcp::dispatch_tool_call`
//!   need to talk to.

pub mod base64_tool;
pub mod builtin;
pub mod calculate;
pub mod count;
pub mod datetime;
pub mod diff_text;
pub mod fetch_url;
pub mod hash;
pub mod ip_tool;
pub mod json_tool;
pub mod pdf;
pub mod sort_tool;
pub mod unit_convert;
pub mod uuid_gen;

/// Read an integer argument a model may have written in float shape.
///
/// Local models routinely emit `5.0` where the schema says `integer`, and
/// `as_i64`/`as_u64` reject that outright — which in the callers that fall
/// back to a default meant the argument was silently ignored (`count: 5.0`
/// generating one UUID) or reported missing when it was plainly there.
/// A float is accepted only when it is exactly integral.
pub fn lenient_i64(args: &serde_json::Value, key: &str) -> Option<i64> {
    let v = args.get(key)?;
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    let f = v.as_f64()?;
    if f.fract() != 0.0 {
        return None;
    }
    // Float→int casts saturate rather than wrap, so round-trip to reject
    // magnitudes i64 can't actually hold.
    let n = f as i64;
    (n as f64 == f).then_some(n)
}
