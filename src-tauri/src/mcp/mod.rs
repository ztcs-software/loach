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
/// servers' tools. Tools are namespaced as `<server-slug>__<tool-slug>`
/// so two servers can both expose a `search` tool without colliding.
///
/// Servers are probed in parallel — one slow server (cold start, network)
/// no longer blocks the aggregate behind it. Per-server timeouts inside
/// `McpSession` still bound the wait.
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

    // Per-server slug, disambiguated up front so two servers with names
    // that slugify to the same string (e.g. "GitHub" and "GitHub!", or
    // an emoji-only name vs another) get distinct prefixes. Without this
    // both servers would land on the same `qualified_name` and
    // `resolve_qualified` would always route to whichever came first.
    let enabled: Vec<McpServer> = servers.into_iter().filter(|s| s.enabled).collect();
    let slugs = build_unique_slugs(&enabled);

    use futures_util::future::join_all;
    let probes = enabled
        .iter()
        .zip(slugs.iter())
        .map(|(server, slug)| async move {
            let result = collect_one(server, slug).await;
            (server.name.clone(), result)
        });

    let results = join_all(probes).await;

    let mut defs: Vec<McpToolDef> = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();
    for (name, result) in results {
        match result {
            Ok(mut these) => defs.append(&mut these),
            Err(e) => {
                // Keep the debug-shape error in logs (operator-facing) but
                // hand the UI a Display-formatted string so internal span
                // paths / source locations don't leak into the chat
                // surface or the MCP status panel.
                tracing::warn!("MCP aggregate: `{name}` failed: {e:#}");
                errors.push((name, format!("{e}")));
            }
        }
    }
    (defs, errors)
}

async fn collect_one(server: &McpServer, slug: &str) -> Result<Vec<McpToolDef>> {
    let (http, _) = pin_client_for(server).await?;
    let mut session = McpSession::new(http, server)?;
    session.initialize().await?;
    let raws = session.list_tools_raw().await?;
    // Hoist the per-server clones out of the loop. The strings end up
    // copied into every `McpToolDef` anyway, but doing it once and reusing
    // the owned values per iteration costs nothing for servers that
    // expose a single tool and starts mattering for servers that expose
    // dozens (the GitHub gateway, internal aggregators).
    let server_id = server.id.clone();
    let server_name = server.name.clone();
    let mut out: Vec<McpToolDef> = Vec::new();
    for t in raws {
        // Sanitise the raw tool name too. Some MCP servers expose tools
        // named `repo.search` or `notebook/list` — perfectly legal in MCP,
        // but both OpenAI and Ollama reject anything outside
        // `^[A-Za-z0-9_-]+$` and a single offender would invalidate the
        // entire tools array for the chat turn. Drop tools whose names
        // can't be made valid rather than poison the catalogue.
        let raw = t.name.clone();
        let safe = sanitise_tool_name(&raw);
        if safe.is_empty() {
            tracing::warn!(
                "MCP aggregate: server `{}` exposes tool `{raw}` whose name has no \
                 [A-Za-z0-9_-] characters — skipping",
                server_name
            );
            continue;
        }
        let qualified = format!("{slug}__{safe}");
        // Two raw names on the same server can sanitise to the same string
        // (`repo.search` and `repo/search` both collapse to `repo_search`).
        // The qualified-name dedup at the slug level only handles cross-
        // server collisions, so a same-server collision would leave two
        // `McpToolDef`s sharing a qualified name. The model would see the
        // duplicate description block and tool-call routing would silently
        // pick one — so drop the second occurrence and warn the operator.
        // First one wins; the server owner can rename one of the colliding
        // tools to recover the dropped one.
        if out.iter().any(|d| d.qualified_name == qualified) {
            tracing::warn!(
                "MCP aggregate: server `{}` exposes tool `{raw}` whose sanitised \
                 name `{qualified}` collides with an earlier tool on the same \
                 server — skipping the duplicate",
                server_name
            );
            continue;
        }
        out.push(McpToolDef {
            server_id: server_id.clone(),
            server_name: server_name.clone(),
            name: raw,
            qualified_name: qualified,
            description: t.description,
            input_schema: t.input_schema.unwrap_or_else(|| {
                serde_json::json!({"type": "object", "properties": {}})
            }),
        });
    }
    Ok(out)
}

/// Invoke one tool by its `server_id` + raw `name`. Looks the server up
/// fresh from the DB per call so a URL or header change between the chat
/// request building and the tool dispatch is reflected immediately. We
/// deliberately *don't* gate on `server.enabled` — `aggregate_tools`
/// already filters disabled servers out of the catalog the model sees,
/// so this path only runs for tools that were exposed when the turn
/// started, and rechecking here would race the actual `tools/call`
/// either way. Returns a structured result the chat pipeline can feed
/// back to the model as a `tool`-role message.
pub async fn dispatch_tool_call(
    db: &Database,
    server_id: &str,
    name: &str,
    arguments: &Value,
) -> Result<McpCallResult> {
    // Built-in tools take a synthetic `server_id` and don't touch the DB
    // or open a network session. Keep the catch ahead of `list_mcp_servers`
    // so the builtin works even when the user has zero MCP servers
    // configured.
    if server_id == crate::tools::calculate::BUILTIN_SERVER_ID {
        return match name {
            crate::tools::calculate::TOOL_NAME => {
                Ok(crate::tools::calculate::dispatch(arguments))
            }
            other => Err(anyhow!("unknown built-in tool `{other}`")),
        };
    }
    let server = db
        .list_mcp_servers()?
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| anyhow!("MCP server `{server_id}` is no longer configured"))?;
    // We *don't* recheck `server.enabled` here: `aggregate_tools` already
    // filters disabled servers out of the catalog the model sees, so this
    // path is only reached for tools the user had enabled at chat-stream
    // start. A check here would still race the actual `tools/call` (the
    // user can flip the toggle during `initialize().await`), so the
    // honest outcome is the same — let the call run, and let the server
    // itself fail naturally if the operator killed the integration mid-
    // conversation.
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

/// Same character class as `slug_for`, but applied to a tool name reported
/// by an MCP server. The model-facing pattern is the same so the
/// transform is identical; kept as a separate function so the intent at
/// each call site is obvious. Returns "" for inputs that contain no
/// usable characters — the caller drops such tools.
fn sanitise_tool_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else if ch == '.' || ch == '/' || ch == ':' || ch.is_whitespace() {
            // Common MCP separators — promote to `_` so namespacey names
            // like `repo.search` survive as `repo_search` rather than
            // collapsing to `reposearch`.
            out.push('_');
        }
        // Everything else is dropped.
    }
    out
}

/// Build per-server slugs, disambiguating collisions by appending a
/// short slice of the server id. The first server to land on a given
/// slug keeps it bare; subsequent collisions get `_<6-char-id>` suffixed
/// so they stay distinct without uglifying the common case.
///
/// When the server id has no usable alphanumeric characters we fall back
/// to a hash of the full id rather than a positional counter — counter-
/// based suffixes would reshuffle whenever a server is added, removed,
/// or simply re-ordered by the DB, breaking the qualified-name → tool
/// mapping that chat history and model prompts hold across restarts.
fn build_unique_slugs(servers: &[McpServer]) -> Vec<String> {
    use std::collections::HashSet;
    let mut taken: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::with_capacity(servers.len());
    for s in servers {
        let base = slug_for(&s.name);
        let slug = if taken.contains(&base) {
            let suffix: String = s
                .id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(6)
                .collect();
            let candidate = if suffix.is_empty() {
                format!("{base}_{}", stable_id_suffix(&s.id))
            } else {
                format!("{base}_{suffix}")
            };
            candidate
        } else {
            base
        };
        taken.insert(slug.clone());
        out.push(slug);
    }
    out
}

/// 6-character base-36 hash of a server id. Stable across runs (same
/// input always yields the same suffix) so a qualified tool name persists
/// even if the DB row order shifts or another server is removed from the
/// configured list. Only used as a defensive fallback when the id itself
/// contains no usable alphanumeric characters.
fn stable_id_suffix(id: &str) -> String {
    // FNV-1a 64-bit. Cheap, no deps, plenty of bits for a 6-char base-36
    // window — collisions in that window only matter inside a single
    // server's `taken` set, which already disambiguates by exact match.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in id.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x00000100000001b3);
    }
    let mut buf = String::with_capacity(6);
    let mut h = hash;
    for _ in 0..6 {
        let d = (h % 36) as u32;
        let ch = if d < 10 {
            (b'0' + d as u8) as char
        } else {
            (b'a' + (d - 10) as u8) as char
        };
        buf.push(ch);
        h /= 36;
    }
    buf
}
