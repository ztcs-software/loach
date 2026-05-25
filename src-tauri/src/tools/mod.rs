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
