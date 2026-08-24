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
//! built from [`crate::tools::fetch_url::resolve_lan_addrs`] +
//! [`crate::tools::fetch_url::build_pinned_client`], so a malicious or
//! misconfigured MCP server URL can't be aimed at the cloud-metadata
//! service. Self-hosted servers on loopback or the local network are
//! allowed — that's the common MCP deployment — only link-local
//! (cloud-metadata) addresses are refused.

pub mod client;
pub mod types;

pub use client::{test_server, McpSession};
pub use types::{Attachment, McpCallResult, McpTestResult, McpToolDef};

use anyhow::{anyhow, bail, Context, Result};
use reqwest::Url;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::db::{Database, McpServer};

/// Build a DNS-pinned reqwest client for a single MCP server URL. Fails
/// if the URL is malformed, the scheme isn't http/https, or any resolved
/// address is link-local (the cloud-metadata range). Loopback and private
/// LAN addresses are allowed.
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
    let addrs = crate::tools::fetch_url::resolve_lan_addrs(&url)
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

/// How long a cached tool catalogue stays fresh before the next chat send
/// re-probes every enabled server. Config edits (add / edit / delete /
/// enable-toggle) and snapshot restores invalidate the cache eagerly via
/// [`invalidate_tools_cache`], so this TTL only bounds how long a server's
/// *own* tool-list change (rare) — or a transient reachability change —
/// stays reflected. Chosen long enough to cover a normal read-then-reply
/// chat cadence (where a 60 s TTL would expire between messages and defeat
/// the purpose) while keeping staleness modest.
const TOOLS_CACHE_TTL: Duration = Duration::from_secs(300);

/// One cached [`aggregate_tools`] result plus the wall-clock instant it was
/// filled, so callers can age it out against [`TOOLS_CACHE_TTL`].
#[derive(Clone)]
pub struct CachedTools {
    cached_at: Instant,
    tools: Vec<McpToolDef>,
    errors: Vec<(String, String)>,
}

/// Process-lifetime cache of the aggregated MCP tool catalogue, parked on
/// `AppState`. `None` = empty/invalidated, so the next read repopulates it.
pub type ToolsCache = Arc<tokio::sync::Mutex<Option<CachedTools>>>;

/// Construct a fresh, empty tool cache for `AppState`.
pub fn new_tools_cache() -> ToolsCache {
    Arc::new(tokio::sync::Mutex::new(None))
}

/// [`aggregate_tools`] for the chat hot path, served from `cache` when the
/// entry is still within [`TOOLS_CACHE_TTL`]. On a miss (or expiry) it runs
/// the live probe — DNS-pin + initialize + tools/list per enabled server —
/// and stores the result so subsequent sends in the same conversation skip
/// that whole round-trip. Returned shape is identical to `aggregate_tools`
/// so the caller (and its cancel-aware `select!`) is unchanged; a cache hit
/// simply resolves near-instantly.
///
/// No single-flight guard: two simultaneous misses may both probe and the
/// last writer wins — acceptable for a desktop app where concurrent sends to
/// the same MCP set are rare, and far simpler than coordinating a barrier.
pub async fn aggregate_tools_cached(
    db: &Database,
    cache: &ToolsCache,
) -> (Vec<McpToolDef>, Vec<(String, String)>) {
    {
        let guard = cache.lock().await;
        if let Some(entry) = guard.as_ref() {
            if entry.cached_at.elapsed() < TOOLS_CACHE_TTL {
                return (entry.tools.clone(), entry.errors.clone());
            }
        }
    }
    let (tools, errors) = aggregate_tools(db).await;
    {
        let mut guard = cache.lock().await;
        *guard = Some(CachedTools {
            cached_at: Instant::now(),
            tools: tools.clone(),
            errors: errors.clone(),
        });
    }
    (tools, errors)
}

/// Drop any cached catalogue so the next chat send re-probes the servers.
/// Must be called after every mutation of the `mcp_servers` table (add /
/// edit / delete / enable-toggle) and after a snapshot restore, or the model
/// would keep seeing the pre-change tool set (including stale slugs, which
/// derive from server names) for up to [`TOOLS_CACHE_TTL`].
pub async fn invalidate_tools_cache(cache: &ToolsCache) {
    *cache.lock().await = None;
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
    // so they work even when the user has zero MCP servers configured.
    if server_id == crate::tools::builtin::BUILTIN_SERVER_ID {
        return crate::tools::builtin::dispatch_builtin_guarded(name, arguments)
            .await
            .ok_or_else(|| anyhow!("unknown built-in tool `{name}`"));
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
    // Reuse an already-initialized session for this server when we have one.
    // Building a fresh one per call meant every `tools/call` paid a DNS
    // resolve, a new TLS handshake, and the two-POST `initialize` dance
    // before doing any work — up to ten turns' worth in a single tool-heavy
    // reply — and threw away the `Mcp-Session-Id` each time, so servers that
    // allocate per-session state accumulated orphans.
    let slot = session_slot(&server.id);
    let mut pooled = slot.lock().await;
    let fingerprint = session_fingerprint(&server);

    // A config edit (URL, headers) or an aged-out entry must not be reused.
    let reusable = pooled.as_ref().is_some_and(|p| {
        p.fingerprint == fingerprint && p.created_at.elapsed() < SESSION_TTL
    });
    if !reusable {
        *pooled = None;
    }

    if let Some(p) = pooled.as_mut() {
        match p.session.call_tool(name, arguments).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                // A *pooled* session failing is the expected shape of "the
                // server expired it while we weren't looking", so rebuild
                // and try once — the same revalidation an HTTP client does
                // for a stale keep-alive connection.
                //
                // Only replay failures the transport could prove happened
                // before dispatch (connect refused, HTTP 404 session
                // rejected). A tool that merely *reports* failure comes back
                // as `Ok` with `is_error` so it never lands here, but a
                // transport error raised after delivery — a timeout, a reset
                // mid-response — may have executed the tool already, and
                // re-running a `send_message` or `create_issue` is worse than
                // reporting the error.
                if !client::is_pre_execution(&e) {
                    return Err(e);
                }
                tracing::debug!(
                    "MCP: pooled session for `{}` failed pre-dispatch ({e:#}) — re-handshaking once",
                    server.name
                );
                *pooled = None;
            }
        }
    }

    let (http, _) = pin_client_for(&server).await?;
    let mut session = McpSession::new(http, &server)?;
    session.initialize().await?;
    let out = session.call_tool(name, arguments).await;
    // Only pool a session that actually worked; a freshly built one that
    // fails is a genuine failure and is never retried.
    if out.is_ok() {
        *pooled = Some(PooledSession {
            fingerprint,
            created_at: Instant::now(),
            session,
        });
    }
    out
}

/// How long a pooled session may be reused before we re-handshake. Servers
/// commonly expire idle sessions on their own schedule; a ceiling well under
/// the usual timeouts keeps the failure-and-retry path rare rather than
/// routine.
const SESSION_TTL: Duration = Duration::from_secs(120);

struct PooledSession {
    /// Config the session was opened against. Any change to the server's URL
    /// or headers makes the pooled entry unusable, which also means a
    /// `mcp_save` needs no explicit invalidation hook — the next call reads
    /// the fresh row and sees a different fingerprint.
    fingerprint: String,
    created_at: Instant,
    session: McpSession,
}

/// Per-server slot. The map lock is held only long enough to clone the
/// `Arc`, so a slow call to one server never blocks calls to another; calls
/// to the *same* server serialize, which is what a stateful session wants.
type SessionSlot = Arc<tokio::sync::Mutex<Option<PooledSession>>>;

static SESSION_POOL: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, SessionSlot>>,
> = std::sync::OnceLock::new();

fn session_slot(server_id: &str) -> SessionSlot {
    let pool = SESSION_POOL.get_or_init(Default::default);
    let mut map = pool.lock().expect("MCP session pool mutex poisoned");
    map.entry(server_id.to_string()).or_default().clone()
}

fn session_fingerprint(server: &crate::db::McpServer) -> String {
    format!(
        "{}\u{1f}{}",
        server.url.trim(),
        server.headers_json.as_deref().unwrap_or("")
    )
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
        let mut slug = if taken.contains(&base) {
            let suffix: String = s
                .id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(6)
                .collect();
            if suffix.is_empty() {
                format!("{base}_{}", stable_id_suffix(&s.id))
            } else {
                format!("{base}_{suffix}")
            }
        } else {
            base.clone()
        };
        // The disambiguated candidate can itself collide — e.g. a third
        // server sharing the same name whose id has the same first 6 alnum
        // chars, or a literal name that slugifies to an already-suffixed
        // form. Fall back to the full-id hash (stable across runs and DB
        // row order, since it derives from the id rather than a counter),
        // then a deterministic counter only if even that clashes.
        if taken.contains(&slug) {
            let hashed = stable_id_suffix(&s.id);
            slug = format!("{base}_{hashed}");
            let mut n = 2;
            while taken.contains(&slug) {
                slug = format!("{base}_{hashed}_{n}");
                n += 1;
            }
        }
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
