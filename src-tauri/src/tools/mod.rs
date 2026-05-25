//! Backend "tools" that augment a chat with out-of-band capabilities.
//!
//! Two flavours live here:
//! * [`fetch_url`] — user-driven URL prefetcher. The frontend scans the
//!   user message, calls `fetch_url` for each link, and inlines the
//!   returned text into the outgoing prompt before streaming starts.
//!   The model doesn't get to *decide* to fetch.
//! * [`calculate`] — model-driven math evaluator. Exposed to the model as
//!   a tool alongside MCP tools (when the user enables the toggle in
//!   Settings → Tools); the model calls it via `tools/call` and the
//!   answer flows back through the standard tool-result path.

pub mod calculate;
pub mod fetch_url;
