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
//! Two layers are exposed:
//!   - [`test_server`] — handshake + tools/list, used by the Settings UI.
//!   - [`aggregate_tools`] + [`dispatch_tool_call`] — used by the chat
//!     pipeline to expose tools to the model and dispatch the model's
//!     tool calls back to the right server.
//!
//! Every outbound HTTP request goes through a DNS-pinned reqwest client
//! built from [`crate::tools::fetch_url::resolve_safe_addrs`] +
//! [`crate::tools::fetch_url::build_pinned_client`], so a malicious or
//! misconfigured MCP server URL can't be aimed at the cloud metadata
//! service or an internal admin endpoint.

pub mod client;
pub mod types;

pub use client::{test_server, McpSession};
pub use types::{McpCallResult, McpTestResult, McpToolDef};

use anyhow::{anyhow, bail, Context, Result};
use reqwest::Url;
use serde_json::Value;

use crate::db::{Database, McpServer};

/// Build a DNS-pinned reqwest client for a single MCP server URL. Fails
/// if the URL is malformed, the scheme isn't http/https, or every
/// resolved address falls inside a private / loopback / link-local range.
async fn pin_client_for(server: &McpServer) -> Result<(reqwest::Client, Url)> {
    let raw = server.url.trim();
    if raw.is_empty() {
        bail!("MCP server `{}` has no URL", server.name);
    }
    let url = Url::parse(raw).with_context(|| format!("MCP server `{}` URL is invalid", server.name))?;
    match url.scheme() {
        "http" | "https" => {}
        other => bail!(
            "MCP server `{}` URL must be http or https (got `{other}`)",
            server.name
        ),
    }
    let addrs = crate::tools::fetch_url::resolve_safe_addrs(&url)
        .await
        .map_err(|e| anyhow!("MCP server `{}` URL rejected: {e}", server.name))?;
    let http = crate::tools::fetch_url::build_pinned_client(&url, &addrs)
        .map_err(|e| anyhow!("could not build pinned client for `{}`: {e}", server.name))?;
    Ok((http, url))
}

/// Collect every tool exposed by every *enabled* MCP server. One server
/// failing (network down, auth expired, schema decode error, …) is logged
/// but does not abort the aggregation — the model still gets the working
/// servers' tools. Tools are namespaced as `<server-slug>__<tool-name>` so
/// two servers can both expose a `search` tool without colliding.
///
/// Returns `(definitions, errors)`: the second value is a list of
/// per-server failures the chat path can surface to the user.
pub async fn aggregate_tools(
    db: &Database,
) -> (Vec<McpToolDef>, Vec<(String, String)>) {
    let servers = match db.list_mcp_servers() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("MCP aggregate: list_mcp_servers failed: {e}");
            return (Vec::new(), vec![("(database)".into(), e.to_string())]);
        }
    };
    let mut defs: Vec<McpToolDef> = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();
    for server in servers.into_iter().filter(|s| s.enabled) {
        match collect_one(&server).await {
            Ok(mut these) => defs.append(&mut these),
            Err(e) => {
                tracing::warn!("MCP aggregate: `{}` failed: {e:#}", server.name);
                errors.push((server.name.clone(), format!("{e:#}")));
            }
        }
    }
    (defs, errors)
}

async fn collect_one(server: &McpServer) -> Result<Vec<McpToolDef>> {
    let (http, _) = pin_client_for(server).await?;
    let mut session = McpSession::new(http, server)?;
    session.initialize().await?;
    let raws = session.list_tools_raw().await?;
    let slug = slug_for(&server.name);
    Ok(raws
        .into_iter()
        .map(|t| {
            let qualified = format!("{slug}__{}", t.name);
            McpToolDef {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                name: t.name,
                qualified_name: qualified,
                description: t.description,
                input_schema: t.input_schema.unwrap_or_else(|| {
                    serde_json::json!({"type": "object", "properties": {}})
                }),
            }
        })
        .collect())
}

/// Invoke one tool by its `server_id` + raw `name`. Looks the server up in
/// the DB fresh per call so a configuration change between the chat
/// request building and the tool dispatch is reflected immediately —
/// notably, disabling a server mid-conversation prevents further calls to
/// it. Returns a structured result the chat pipeline can feed back to the
/// model as a `tool`-role message.
pub async fn dispatch_tool_call(
    db: &Database,
    server_id: &str,
    name: &str,
    arguments: &Value,
) -> Result<McpCallResult> {
    let server = db
        .list_mcp_servers()?
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| anyhow!("MCP server `{server_id}` is no longer configured"))?;
    if !server.enabled {
        bail!("MCP server `{}` is disabled", server.name);
    }
    let (http, _) = pin_client_for(&server).await?;
    let mut session = McpSession::new(http, &server)?;
    session.initialize().await?;
    session.call_tool(name, arguments).await
}

/// Tool names exposed to the LLM must match a fairly narrow pattern —
/// both OpenAI and Ollama expect `^[A-Za-z0-9_-]+$`. Server names are
/// free-form ("GitHub", "ACME — production", "💼"), so we slugify them
/// here. Empty / all-punctuation names fall back to `srv`.
fn slug_for(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
        // Anything else (punctuation, emoji, non-ASCII) is dropped.
    }
    if out.is_empty() {
        "srv".to_string()
    } else {
        out
    }
}
