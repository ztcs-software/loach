//! Backend "tools" that augment a chat with out-of-band capabilities.
//!
//! Four flavours live here:
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
//! * Workspace filesystem tools ([`fs`]) — the same model-driven shape,
//!   but scoped to the directory the user picked for the current chat.
//!   They are the only built-ins that touch the disk, the only ones that
//!   need context beyond their arguments, and the only ones whose
//!   mutating half goes through the per-call approval prompt.
//! * [`run_script`] — runs code the model wrote, or a script in the
//!   workspace, asking every time. Outside the registry: a run is a
//!   process, not an in-process call.

pub mod base64_tool;
pub mod builtin;
pub mod calculate;
pub mod count;
pub mod datetime;
pub mod diff_text;
pub mod fetch_url;
pub mod fs;
pub mod hash;
pub mod ip_tool;
pub mod json_tool;
pub mod pdf;
pub mod run_script;
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
    lenient_i64_value(args.get(key)?)
}

/// [`lenient_i64`] for a value already in hand — a field inside a nested
/// spec rather than a top-level argument.
///
/// A string holding one counts too (`"5"`, `"5.0"`): local models write
/// those as well, and they were reported missing or silently ignored.
pub fn lenient_i64_value(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(s) = v.as_str() {
        let s = s.trim();
        return s.parse::<i64>().ok().or_else(|| integral(s.parse::<f64>().ok()?));
    }
    integral(v.as_f64()?)
}

/// `f` as an i64 when it is exactly a whole number i64 can hold.
fn integral(f: f64) -> Option<i64> {
    if f.fract() != 0.0 {
        return None;
    }
    // Float→int casts saturate rather than wrap, so round-trip to reject
    // magnitudes i64 can't actually hold.
    let n = f as i64;
    (n as f64 == f).then_some(n)
}

/// A number argument, also when written as a string (`"12.5"`).
pub fn lenient_f64(args: &serde_json::Value, key: &str) -> Option<f64> {
    let v = args.get(key)?;
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())
}

/// A boolean argument, also when written as the string `"true"` or `"false"`.
pub fn lenient_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    let v = args.get(key)?;
    v.as_bool().or_else(|| match v.as_str()?.trim().to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    })
}

/// An optional integer argument: `default` when it's absent, an error when
/// it's there but no integer. Falling back to the default for a value the
/// model plainly sent hid its mistake (`count: "five"` made one UUID).
pub fn int_arg(args: &serde_json::Value, key: &str, default: i64) -> Result<i64, String> {
    match args.get(key) {
        None | Some(serde_json::Value::Null) => Ok(default),
        Some(v) => lenient_i64_value(v).ok_or_else(|| format!("`{key}` must be an integer")),
    }
}

/// [`int_arg`] for a boolean.
pub fn bool_arg(args: &serde_json::Value, key: &str, default: bool) -> Result<bool, String> {
    match args.get(key) {
        None | Some(serde_json::Value::Null) => Ok(default),
        Some(_) => lenient_bool(args, key).ok_or_else(|| format!("`{key}` must be true or false")),
    }
}

/// A tool's error result.
pub(crate) fn err(msg: impl Into<String>) -> crate::mcp::types::McpCallResult {
    crate::mcp::types::McpCallResult {
        content_text: msg.into(),
        is_error: true,
        ..Default::default()
    }
}

/// A tool's plain-text result.
pub(crate) fn ok(text: impl Into<String>) -> crate::mcp::types::McpCallResult {
    crate::mcp::types::McpCallResult {
        content_text: text.into(),
        is_error: false,
        ..Default::default()
    }
}

/// `bytes` as lowercase hex, into one buffer (it was a `format!` a byte).
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(DIGITS[usize::from(b >> 4)] as char);
        s.push(DIGITS[usize::from(b & 0xf)] as char);
    }
    s
}
