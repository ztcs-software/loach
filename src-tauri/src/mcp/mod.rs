//! Minimal Model Context Protocol (MCP) client.
//!
//! Loach only speaks the **Streamable-HTTP** transport:
//!   - Client POSTs JSON-RPC bodies to a single URL.
//!   - Server may reply with either `application/json` or a
//!     `text/event-stream` whose first `data:` frame carries the JSON-RPC
//!     response — we handle both.
//!   - Session continuity is via the `Mcp-Session-Id` response header, which
//!     we echo back on subsequent requests.
//!
//! Stdio and the legacy two-endpoint SSE transport are intentionally *not*
//! supported; those roles are better served by dedicated gateways and keep
//! the UI/config surface small.
//!
//! What's NOT here (yet):
//!   - Actually calling a tool. The current surface only verifies that a
//!     server comes up and advertises tools; wiring tool calls into chat
//!     streaming is a separate follow-on.
//!
//! The public entry point is [`test_server`], which performs the handshake
//! (`initialize` → `notifications/initialized` → `tools/list`) and returns
//! a summary for the Settings UI.

pub mod client;
pub mod types;

pub use client::test_server;
pub use types::McpTestResult;
