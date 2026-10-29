use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::db::McpServer;
use crate::sse::{find_frame_end, frame_lines};

use super::stdio::{classify, server_request_reply, Incoming};
use super::types::{
    Attachment, CallToolContent, CallToolResult, InitializeResult, JsonRpcError, JsonRpcResponse,
    ListToolsResult, McpCallResult, McpTestResult, McpTool, McpToolRaw, MAX_TOOL_CALL_TIME,
    MAX_TOOL_PAGES, PROTOCOL_VERSION,
};

/// Per-request ceiling. Remote MCP servers can take a few seconds to cold
/// start (especially gateway-backed ones), so we give each JSON-RPC call
/// 30 s before giving up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Marker attached to failures that provably happened *before* the server
/// could dispatch the tool — the TCP connection never came up, or the server
/// rejected our session outright with 404.
///
/// `dispatch_tool_call` retries a failed pooled session once, and needs to
/// know which failures are safe to replay. A transport error raised *after*
/// the request was delivered (a timeout, a connection reset while reading the
/// response) may well have executed the tool already, and re-running one with
/// side effects — `send_message`, `create_issue` — is worse than surfacing
/// the error. Only failures carrying this marker are retried.
#[derive(Debug)]
pub struct PreExecutionFailure;

impl std::fmt::Display for PreExecutionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("request failed before the server could run the tool")
    }
}

impl std::error::Error for PreExecutionFailure {}

/// True when `err` was tagged [`PreExecutionFailure`] anywhere in its chain.
///
/// `downcast_ref`, not `chain()`: the tag is always attached with
/// `.context(…)`, and `chain()` hands a context layer back as anyhow's own
/// wrapper type, so the tag was never found and no failure was ever retried.
pub fn is_pre_execution(err: &anyhow::Error) -> bool {
    err.downcast_ref::<PreExecutionFailure>().is_some()
}

/// A JSON-RPC `error` reply — invalid params, an unknown tool. The server
/// got the request and answered it, so unlike a transport failure it says
/// nothing against the session it came over (see `mcp::keeps_session`).
#[derive(Debug)]
pub struct RpcError(JsonRpcError);

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&format_rpc_error(&self.0))
    }
}

impl std::error::Error for RpcError {}

/// True when `err` is an [`RpcError`] reply.
pub fn is_rpc_error(err: &anyhow::Error) -> bool {
    err.chain().any(|c| c.is::<RpcError>())
}

/// Cap on the response body we'll buffer per JSON-RPC call. MCP responses
/// in practice are kilobytes (an initialize handshake or a tools/list of
/// a few dozen tools); 4 MiB leaves a generous safety margin while still
/// catching a malicious or misconfigured server that streams arbitrary
/// data at us (e.g. accidentally pointing the URL at a static-file host
/// that returns a multi-GB asset). Without the cap, `resp.text().await`
/// allocates linearly with the response and would OOM the app.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Hard limit on the `Mcp-Session-Id` we'll accept from a server and echo
/// back on subsequent requests. A real session ID is a short opaque token
/// (UUID-ish, ≤64 chars in the reference implementation). Refusing
/// anything longer prevents a hostile or misconfigured server from
/// burning client memory + bandwidth by returning a multi-megabyte ID
/// that we then forward on every call for the rest of the session.
const MAX_SESSION_ID_BYTES: usize = 1024;

/// Ceiling on the concatenated text content we'll return from a single
/// `tools/call`, applied at the MCP layer before the provider re-caps it
/// per `MAX_TOOL_RESULT_BYTES`. The provider cap (32 KiB at present) is
/// the one that bounds what reaches the model, but a buggy or hostile
/// server can emit content arrays whose individual `text` pieces dwarf
/// that limit and force us to allocate the full string before truncation
/// runs. 256 KiB is two orders of magnitude over realistic tool output
/// (search results, snippets, error messages) while staying small enough
/// that even a flood of huge text fragments can't OOM the renderer.
const MAX_TOOL_RESULT_TEXT_BYTES: usize = 256 * 1024;

/// Per-`Resource` ceiling when we stringify a `CallToolContent::Resource`
/// into the tool result. A resource is opaque JSON that the server thinks
/// is relevant to the tool call; we don't render it specially, just
/// `.to_string()` it as a fallback. A pathological server could return a
/// multi-MB nested object — cap each one at 4 KiB so a long resource list
/// doesn't blow past `MAX_TOOL_RESULT_TEXT_BYTES` on the strength of a
/// single oversized resource.
const MAX_RESOURCE_STRINGIFIED_BYTES: usize = 4 * 1024;

const CLIENT_NAME: &str = "loach";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Accept a server-returned session ID iff it's within the size budget.
/// Logs a warning and returns `None` for oversized IDs so the rest of
/// the session proceeds as if the server hadn't advertised one (the
/// reference MCP HTTP transport tolerates this — the next request just
/// looks like a fresh session, which is the safer failure mode).
fn accept_session_id(sid: Option<String>) -> Option<String> {
    match sid {
        Some(s) if s.len() > MAX_SESSION_ID_BYTES => {
            tracing::warn!(
                "MCP: server returned a {}-byte session id (limit {}); dropping it",
                s.len(),
                MAX_SESSION_ID_BYTES
            );
            None
        }
        other => other,
    }
}

/// A live MCP session bound to one server. Holds the URL, headers, and the
/// session id returned by the initial handshake so subsequent calls
/// (`tools/list`, `tools/call`) reuse the same conversation rather than
/// re-initialising each round-trip. Cheap to construct — no network until
/// the first `initialize()` call.
pub struct McpSession {
    http: reqwest::Client,
    url: String,
    headers: HashMap<String, String>,
    session_id: Option<String>,
    /// The protocol version `initialize` settled on, sent back as
    /// `MCP-Protocol-Version` on every request after it, as the spec asks of
    /// HTTP clients. `None` before that, or when the server named none (or
    /// something that can't go in a header).
    protocol_version: Option<String>,
    /// Monotonic JSON-RPC `id` counter. Streamable HTTP is one-POST-one-
    /// reply, but the reply may share its SSE stream with the server's own
    /// messages, so it is told apart by this id.
    next_id: i64,
}

impl McpSession {
    pub fn new(http: reqwest::Client, server: &McpServer) -> Result<Self> {
        let url = server.url.trim();
        if url.is_empty() {
            bail!("MCP server URL is empty");
        }
        let headers: HashMap<String, String> = match server.headers_json.as_deref() {
            Some(s) if !s.trim().is_empty() => serde_json::from_str(s)
                .context("headers_json is not a JSON object of strings")?,
            _ => HashMap::new(),
        };
        Ok(Self {
            http,
            url: url.to_string(),
            headers,
            session_id: None,
            protocol_version: None,
            next_id: 1,
        })
    }

    fn fresh_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Run the `initialize` + `notifications/initialized` handshake. Must
    /// be the first call on a fresh session.
    pub async fn initialize(&mut self) -> Result<InitializeResult> {
        let init = json!({
            "jsonrpc": "2.0",
            "id": self.fresh_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
            },
        });
        let (resp, sid) = post_rpc(self, &init).await?;
        if let Some(s) = accept_session_id(sid) {
            self.session_id = Some(s);
        }
        let parsed: InitializeResult = unwrap_response(resp)?;
        self.protocol_version = parsed.protocol_version.clone().filter(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        });

        // Best-effort initialized notification. Some servers (notably the
        // GitHub gateway) require this before they'll honour tools/* calls.
        let note = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        let _ = post_rpc_raw(self, &note).await;

        Ok(parsed)
    }

    /// Fetch the full tool catalog, every page of it. Returns the raw shape
    /// (includes the JSON-Schema for each tool's arguments) so callers that
    /// need to forward schemas to an LLM don't lose them.
    pub async fn list_tools_raw(&mut self) -> Result<Vec<McpToolRaw>> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for page in 1.. {
            let mut body = json!({
                "jsonrpc": "2.0",
                "id": self.fresh_id(),
                "method": "tools/list",
            });
            if let Some(c) = cursor.take() {
                body["params"] = json!({ "cursor": c });
            }
            let (resp, sid) = post_rpc(self, &body).await?;
            if let Some(s) = accept_session_id(sid) {
                self.session_id = Some(s);
            }
            let parsed: ListToolsResult = unwrap_response(resp)?;
            tools.extend(parsed.tools);
            match parsed.next_cursor.filter(|c| !c.is_empty()) {
                None => break,
                Some(_) if page >= MAX_TOOL_PAGES => {
                    tracing::warn!(
                        "MCP: tools/list still paging after {MAX_TOOL_PAGES} pages — keeping what's in"
                    );
                    break;
                }
                next => cursor = next,
            }
        }
        Ok(tools)
    }

    /// Invoke a single tool. Returns the concatenated text content + the
    /// server's `isError` flag. `arguments` is a JSON object the model
    /// constructed against the tool's input schema; we forward it verbatim
    /// without validating against the schema (the server will reject
    /// invalid shapes itself and the model will react to the error).
    pub async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<McpCallResult> {
        let id = self.fresh_id();
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments,
                // Asks for progress under the call's own id; a long tool that
                // reports it keeps the call's deadline moving (see
                // `post_rpc_raw`).
                "_meta": { "progressToken": id },
            },
        });
        let (resp, sid) = post_rpc(self, &body).await?;
        if let Some(s) = accept_session_id(sid) {
            self.session_id = Some(s);
        }
        let parsed: CallToolResult = unwrap_response(resp)?;
        // Fold the content array (text, images, resources) into the
        // flattened result. Extracted as a pure function so the mapping —
        // notably image → attachment — is unit-testable without a live
        // server.
        Ok(assemble_call_result(parsed.content, parsed.is_error))
    }

    /// A request carrying everything that places it in this session: the
    /// configured headers, the session id, the negotiated protocol version.
    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut req = self.http.request(method, &self.url);
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(s) = &self.session_id {
            req = req.header("Mcp-Session-Id", s);
        }
        if let Some(v) = &self.protocol_version {
            req = req.header("MCP-Protocol-Version", v);
        }
        req
    }
}

/// End the session on the server — the spec's HTTP DELETE — whenever one is
/// dropped: replaced in the pool, aged out, or done with after a Test
/// connection. Without it every session Loach ever opened stayed allocated
/// until the server expired it. Best effort, and only from the runtime: at
/// app exit nothing would be left to send it.
impl Drop for McpSession {
    fn drop(&mut self) {
        if self.session_id.is_none() {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let req = self.request(reqwest::Method::DELETE).timeout(REQUEST_TIMEOUT);
        rt.spawn(async move {
            // A server that doesn't support it answers 405, which is fine.
            let _ = req.send().await;
        });
    }
}

/// Fold a tool's content array into the result we hand the provider layer:
/// text pieces concatenated under a running byte cap, `Image` content
/// surfaced as image attachments (the frontend renders them inline rather
/// than dropping them to a placeholder), and resources stringified with a
/// per-item cap. Pure and allocation-bounded so it's unit-testable without
/// a live server.
pub(super) fn assemble_call_result(content: Vec<CallToolContent>, is_error: bool) -> McpCallResult {
    let mut text = String::new();
    let mut attachments: Vec<Attachment> = Vec::new();
    let mut truncated = false;
    for piece in content {
        match piece {
            CallToolContent::Text { text: t } => {
                truncated |= append_capped(&mut text, &t);
            }
            CallToolContent::Image { data, mime_type } => {
                // Surface the image as an attachment so the frontend can
                // render it. The model is text-only, so it still gets a
                // short breadcrumb in the result text.
                let mime = mime_type.unwrap_or_else(|| "image/png".to_string());
                let name = image_attachment_name(&mime, attachments.len());
                attachments.push(Attachment {
                    kind: "image".to_string(),
                    name,
                    mime,
                    data,
                    ..Default::default()
                });
                truncated |= append_capped(&mut text, "[image attached]");
            }
            CallToolContent::Resource { resource } => {
                if let Some(r) = resource {
                    // Cap the per-resource stringification too — a single
                    // huge nested object can otherwise dominate the
                    // result and crowd out the actual tool output.
                    let s = r.to_string();
                    let capped = clip_on_char_boundary(&s, MAX_RESOURCE_STRINGIFIED_BYTES);
                    truncated |= append_capped(&mut text, capped);
                    if capped.len() < s.len() {
                        truncated |= append_capped(&mut text, "[…resource truncated]");
                    }
                } else {
                    truncated |= append_capped(&mut text, "[resource]");
                }
            }
            CallToolContent::Audio { mime_type } => {
                let label = mime_type
                    .as_deref()
                    .map(|m| format!("[audio: {m}]"))
                    .unwrap_or_else(|| "[audio]".to_string());
                truncated |= append_capped(&mut text, &label);
            }
            CallToolContent::ResourceLink { uri, name } => {
                let label = match (name.as_deref(), uri.as_deref()) {
                    (Some(n), Some(u)) => format!("[resource: {n} — {u}]"),
                    (Some(n), None) => format!("[resource: {n}]"),
                    (None, Some(u)) => format!("[resource: {u}]"),
                    (None, None) => "[resource]".to_string(),
                };
                truncated |= append_capped(&mut text, &label);
            }
            CallToolContent::Unknown => {
                // A breadcrumb, not silence: dropping these made a result
                // composed entirely of unhandled types look like an empty
                // (but successful) tool call.
                truncated |= append_capped(&mut text, "[unsupported content type]");
            }
        }
        if truncated {
            // Stop walking the content array once we've crossed the cap;
            // the provider sees more than enough already.
            break;
        }
    }
    if truncated {
        // Append the truncation notice unconditionally — `append_capped`
        // would otherwise consume it as part of the budget and the
        // marker would never appear in the output. A ~100-byte
        // overage on a 256 KiB cap is fine; the provider-layer
        // re-cap (32 KiB) is the one that actually bounds what
        // reaches the model anyway.
        text.push_str("\n\n[…tool result truncated by Loach; ask the tool again with narrower arguments]");
    }
    if text.is_empty() && is_error {
        text.push_str("tool returned no content");
    }
    McpCallResult {
        content_text: text,
        is_error,
        attachments,
    }
}

/// Filename for an image attachment derived from an MCP `Image` block.
/// The extension only drives how the frontend labels / downloads it.
fn image_attachment_name(mime: &str, idx: usize) -> String {
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "img",
    };
    format!("mcp-image-{}.{ext}", idx + 1)
}

/// Append `chunk` to `out`, inserting a newline between non-empty pieces.
/// Once `out` would cross `MAX_TOOL_RESULT_TEXT_BYTES`, write only enough
/// of `chunk` to land exactly on the cap (on a UTF-8 boundary) and return
/// `true` so the caller can stop iterating.
fn append_capped(out: &mut String, chunk: &str) -> bool {
    if !out.is_empty() {
        out.push('\n');
    }
    let remaining = MAX_TOOL_RESULT_TEXT_BYTES.saturating_sub(out.len());
    if chunk.len() <= remaining {
        out.push_str(chunk);
        false
    } else {
        out.push_str(clip_on_char_boundary(chunk, remaining));
        true
    }
}

/// Largest prefix of `s` that fits in `max_bytes` and lands on a UTF-8
/// codepoint boundary. Naive `&s[..max_bytes]` panics on multi-byte
/// sequences whose middle aligns with the cap.
fn clip_on_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut idx = max_bytes;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    &s[..idx]
}

/// Probe an MCP server: handshake + list tools. Never panics; any failure
/// is packaged into `McpTestResult::failure`.
pub async fn test_server(server: &McpServer, http: &reqwest::Client) -> McpTestResult {
    match test_http(server, http).await {
        Ok(r) => r,
        Err(e) => McpTestResult::failure(format!("{e:#}")),
    }
}

async fn test_http(server: &McpServer, http: &reqwest::Client) -> Result<McpTestResult> {
    let mut session = McpSession::new(http.clone(), server)?;
    let init = session.initialize().await?;
    let tools = session.list_tools_raw().await?;

    Ok(McpTestResult {
        ok: true,
        server_name: init.server_info.as_ref().and_then(|s| s.name.clone()),
        server_version: init
            .server_info
            .as_ref()
            .and_then(|s| s.version.clone()),
        protocol_version: init.protocol_version,
        tools: tools
            .into_iter()
            .map(|t| McpTool {
                name: t.name,
                description: t.description,
            })
            .collect(),
        error: None,
    })
}

pub(super) fn unwrap_response<T: serde::de::DeserializeOwned>(resp: JsonRpcResponse) -> Result<T> {
    if let Some(err) = resp.error {
        return Err(RpcError(err).into());
    }
    let result = resp
        .result
        .ok_or_else(|| anyhow!("response missing both result and error"))?;
    serde_json::from_value(result).context("could not decode result payload")
}

fn format_rpc_error(err: &JsonRpcError) -> String {
    format!("server returned error {}: {}", err.code, err.message)
}

/// POST a JSON-RPC frame, returning the decoded response and any session-id
/// header the server advertised.
async fn post_rpc(
    session: &McpSession,
    body: &Value,
) -> Result<(JsonRpcResponse, Option<String>)> {
    let (raw, sid) = post_rpc_raw(session, body).await?;
    // `truncate` the body before it lands in the message: `raw` is bounded
    // only by MAX_RESPONSE_BYTES (4 MiB), and this error string is surfaced
    // as a ToolResult event that gets persisted into the transcript and
    // logged in full.
    let parsed: JsonRpcResponse = serde_json::from_str(&raw)
        .with_context(|| format!("server sent invalid JSON-RPC frame: {}", truncate(&raw)))?;
    Ok((parsed, sid))
}

async fn post_rpc_raw(
    session: &McpSession,
    body: &Value,
) -> Result<(String, Option<String>)> {
    // A request that asked for progress (`tools/call`) may run past
    // REQUEST_TIMEOUT for as long as the server keeps reporting progress
    // on it, up to MAX_TOOL_CALL_TIME. reqwest's own timeout can't move,
    // so for such a request it holds only that cap, and `deadline` —
    // which the SSE reader moves on each report — the rest.
    let reports_progress = body.pointer("/params/_meta/progressToken").is_some();
    let started = tokio::time::Instant::now();
    let deadline = started + REQUEST_TIMEOUT;
    let req = session
        .request(reqwest::Method::POST)
        .header("Content-Type", "application/json")
        // Streamable HTTP servers can reply with either JSON or SSE; tell
        // them we'll accept either so we get the most compatible response.
        .header("Accept", "application/json, text/event-stream")
        .json(body)
        .timeout(if reports_progress { MAX_TOOL_CALL_TIME } else { REQUEST_TIMEOUT });

    let Ok(sent) = tokio::time::timeout_at(deadline, req.send()).await else {
        bail!(
            "POST to MCP server failed: no response within {}s",
            REQUEST_TIMEOUT.as_secs()
        );
    };
    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            // A connect-phase failure means the request never reached the
            // server, so replaying it can't double-run anything. Anything
            // else (notably a timeout) may have been delivered and executed.
            let tag_safe = e.is_connect();
            // Without the URL reqwest quotes: this text reaches the model and
            // the transcript, and an MCP URL can carry its credential in the
            // path or query (`https://mcp.zapier.com/api/mcp/s/<secret>/mcp`).
            let err = anyhow::Error::new(e.without_url()).context("POST to MCP server failed");
            return Err(if tag_safe {
                err.context(PreExecutionFailure)
            } else {
                err
            });
        }
    };
    let status = resp.status();
    let sid = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !status.is_success() {
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let text = read_capped_text(resp)
            .await
            .context("read MCP server response")?;
        // Redirects aren't followed — the client is pinned to the address
        // it resolved — so a bare "HTTP 307" left the user guessing where
        // the server wanted them. Usually it's a missing trailing `/`.
        let hint = location
            .filter(|_| status.is_redirection())
            .and_then(|l| redirect_hint(&session.url, &l));
        let err = match hint {
            Some(hint) => anyhow!("server responded with HTTP {status}: {hint}"),
            None => anyhow!("server responded with HTTP {}: {}", status, truncate(&text)),
        };
        // 404 against a session-carrying request is the spec's "unknown or
        // expired session" signal: the server refused the envelope, so it
        // never got as far as running the tool. That's the case the pooled
        // retry exists for.
        return Err(if status == reqwest::StatusCode::NOT_FOUND && session.session_id.is_some() {
            err.context(PreExecutionFailure)
        } else {
            err
        });
    }

    // Streamable HTTP may push its JSON inside a `data:` frame of an SSE
    // stream. Read those incrementally rather than to EOF — see
    // `read_sse_rpc_response`.
    let payload = if content_type.contains("text/event-stream") {
        let id = body.get("id").and_then(Value::as_i64);
        let progress_cap = reports_progress.then_some(started + MAX_TOOL_CALL_TIME);
        read_sse_rpc_response(session, resp, id, deadline, progress_cap).await?
    } else {
        let Ok(text) = tokio::time::timeout_at(deadline, read_capped_text(resp)).await else {
            bail!(
                "MCP server didn't finish its reply within {}s",
                REQUEST_TIMEOUT.as_secs()
            );
        };
        text.context("read MCP server response")?
    };

    Ok((payload, sid))
}

/// Pull the JSON-RPC *response* out of an SSE body, returning as soon as
/// it arrives instead of draining the stream first.
///
/// Two things went wrong with read-to-EOF-then-parse. The spec only
/// *SHOULD* close the stream after the response, so a server that
/// legitimately holds it open stalled every call until the 30 s request
/// timeout — the reply had been sitting in our buffer the whole time. And
/// a server may send its own messages on the same stream *before* the
/// response — notifications (progress updates, logging), and requests of
/// its own, a `ping` above all — which `extract_first_sse_data` would hand
/// back as if they were the answer.
///
/// So: parse frames as they complete, answer the server's requests, let
/// progress on this request (`id`) move `deadline` — up to `progress_cap`,
/// for a request that asked for progress — skip the rest, and return the
/// frame carrying the reply to `id`. Dropping the response afterwards
/// closes the connection.
async fn read_sse_rpc_response(
    session: &McpSession,
    resp: reqwest::Response,
    id: Option<i64>,
    mut deadline: tokio::time::Instant,
    progress_cap: Option<tokio::time::Instant>,
) -> Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut scanned = 0usize;
    let mut stream = resp.bytes_stream();

    loop {
        // Frames are separated by a blank line. Parse every complete one we
        // have before asking for more bytes.
        while let Some((end, delim_len)) = find_frame_end(&buf[scanned..]) {
            let frame_end = scanned + end;
            let frame = String::from_utf8_lossy(&buf[..frame_end]).into_owned();
            // Drop the frame AND its full delimiter, then rescan from the
            // start of what's left.
            let consumed = (frame_end + delim_len).min(buf.len());
            buf.drain(..consumed);
            scanned = 0;

            if let Some(data) = extract_first_sse_data(&frame) {
                match sse_frame(&data, id) {
                    SseFrame::Reply => return Ok(data),
                    SseFrame::Answer(reply) => answer(session, &reply),
                    SseFrame::Progress => {
                        if let Some(cap) = progress_cap {
                            deadline = (tokio::time::Instant::now() + REQUEST_TIMEOUT).min(cap);
                        }
                    }
                    // Legal to receive here. Keep reading for the
                    // response the caller is actually waiting on.
                    SseFrame::Skip => {}
                }
            }
        }
        // No complete frame yet. Resume the next scan a few bytes back from
        // the end rather than at it: the longest delimiter is 4 bytes, so a
        // `\r\n\r\n` split across two chunks would be missed entirely if we
        // restarted past its first byte.
        scanned = buf.len().saturating_sub(3);

        let Ok(next) = tokio::time::timeout_at(deadline, stream.next()).await else {
            bail!(
                "MCP server didn't reply in time — {}s went by without the reply or progress on it",
                REQUEST_TIMEOUT.as_secs()
            );
        };
        match next {
            Some(chunk) => {
                let chunk = chunk.context("reading MCP server response body")?;
                if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    bail!(
                        "MCP server response exceeded {MAX_RESPONSE_BYTES} bytes — refusing to buffer further"
                    );
                }
                buf.extend_from_slice(&chunk);
            }
            // Stream ended. Anything left is a final frame without its
            // terminating blank line — accept it if it's the reply.
            None => {
                let tail = String::from_utf8_lossy(&buf).into_owned();
                return extract_first_sse_data(&tail)
                    .filter(|d| sse_frame(d, id) == SseFrame::Reply)
                    .ok_or_else(|| anyhow!("event-stream response contained no data frame"));
            }
        }
    }
}

/// Answer a request the server made of us on a reply's stream. It goes
/// back as a POST of its own, like any client message, and in the
/// background, so the wait for the reply carries on. Best effort.
fn answer(session: &McpSession, reply: &Value) {
    let req = session
        .request(reqwest::Method::POST)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(reply)
        .timeout(REQUEST_TIMEOUT);
    tokio::spawn(async move {
        let _ = req.send().await;
    });
}

/// What one `data:` payload on a request's SSE stream is to that request.
#[derive(Debug, PartialEq)]
enum SseFrame {
    /// Its reply — or something unreadable, which the caller then reports.
    Reply,
    /// A request the server makes of us first (`ping`); this is the answer.
    Answer(Value),
    /// Progress on the request.
    Progress,
    /// Anything else: other notifications, a reply to some other id.
    Skip,
}

/// Sort a payload by what it is to the request with `id`. The first frame
/// that wasn't a notification used to be taken for the reply, so a `ping`
/// the server sent ahead of it failed the call.
fn sse_frame(data: &str, id: Option<i64>) -> SseFrame {
    let Ok(msg) = serde_json::from_str::<Value>(data) else {
        return SseFrame::Reply;
    };
    match classify(&msg) {
        Incoming::Response(r) if id.is_none_or(|id| id == r) => SseFrame::Reply,
        Incoming::Response(_) => SseFrame::Skip,
        Incoming::Request { id: theirs, method } => {
            SseFrame::Answer(server_request_reply(&method, theirs))
        }
        Incoming::Progress(token) if Some(token) == id => SseFrame::Progress,
        Incoming::Progress(_) | Incoming::Notification => SseFrame::Skip,
        Incoming::Other => SseFrame::Reply,
    }
}

/// What a 3xx points at, for the error. Said without quoting the target's
/// path or query, which can carry the server's credential just as the
/// configured URL can (see the connect error in `post_rpc_raw`) — except for
/// the usual case, the same URL with or without a trailing `/`, which is
/// spelled out because the fix is the user's to make.
fn redirect_hint(from: &str, location: &str) -> Option<String> {
    let from = reqwest::Url::parse(from).ok()?;
    let to = from.join(location).ok()?;
    let same_origin = from.origin() == to.origin();
    if same_origin
        && from.query() == to.query()
        && from.path() != to.path()
        && from.path().trim_end_matches('/') == to.path().trim_end_matches('/')
    {
        return Some(if to.path().ends_with('/') {
            "it redirects to the same URL with a trailing `/` — add one to the server URL".into()
        } else {
            "it redirects to the same URL without its trailing `/` — remove it from the server URL"
                .into()
        });
    }
    Some(if same_origin {
        "it redirects to another address on the same server".into()
    } else {
        format!("it redirects to {}", to.origin().ascii_serialization())
    })
}

/// Read a reqwest response body as text with a hard `MAX_RESPONSE_BYTES`
/// cap. Streams chunks rather than calling `resp.text().await` so a
/// pathological multi-GB body can't allocate before we get a chance to
/// stop reading. Errors with a clear message when the cap is exceeded so
/// users see "MCP server response too large" instead of a generic OOM.
async fn read_capped_text(resp: reqwest::Response) -> Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("reading MCP server response body")?;
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            bail!(
                "MCP server response exceeded {MAX_RESPONSE_BYTES} bytes — refusing to buffer further"
            );
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).context("MCP server response was not valid UTF-8")
}

fn extract_first_sse_data(s: &str) -> Option<String> {
    // A single SSE event's payload may span multiple consecutive `data:`
    // lines, which the spec says to join with `\n`. The previous version
    // returned only the first line, so a server that split its JSON-RPC
    // response across several `data:` lines (legal SSE) handed us a
    // truncated, unparseable frame and its tools silently never loaded.
    // Gather every `data:` line of the first event (terminated by a blank
    // line) and join them. Lines may end in `\r` alone, too.
    let mut data: Vec<&str> = Vec::new();
    for line in frame_lines(s) {
        if let Some(rest) = line.strip_prefix("data:") {
            // Per spec, a single leading space after the colon is stripped.
            data.push(rest.strip_prefix(' ').unwrap_or(rest));
        } else if line.is_empty() {
            // Blank line ends the event. Stop once we have a payload;
            // otherwise keep scanning past leading comments / other events.
            if !data.is_empty() {
                break;
            }
        }
        // Other field lines (event:, id:, retry:, comments) are ignored.
    }
    if data.is_empty() {
        None
    } else {
        Some(data.join("\n"))
    }
}

fn truncate(s: &str) -> String {
    // Char-boundary safe truncation. The previous version sliced `&s[..MAX]`
    // by byte index, which panics with "byte index N is not a char boundary"
    // when a multi-byte UTF-8 sequence straddled the 300-byte mark — which
    // is reachable any time an MCP server returns a non-ASCII error body.
    const MAX: usize = 300;
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let cut = s
        .char_indices()
        .nth(MAX)
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    format!("{}…", &s[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn image_content_becomes_an_attachment() {
        let content = vec![CallToolContent::Image {
            data: "aGVsbG8=".to_string(),
            mime_type: Some("image/jpeg".to_string()),
        }];
        let r = assemble_call_result(content, false);
        assert_eq!(r.attachments.len(), 1);
        let a = &r.attachments[0];
        assert_eq!(a.kind, "image");
        assert_eq!(a.mime, "image/jpeg");
        assert_eq!(a.data, "aGVsbG8=");
        assert!(a.name.ends_with(".jpg"), "name: {}", a.name);
        // The text-only model still gets a breadcrumb that an image returned.
        assert!(r.content_text.contains("image attached"));
        assert!(!r.is_error);
    }

    #[test]
    fn image_defaults_mime_when_missing() {
        let content = vec![CallToolContent::Image {
            data: "eA==".to_string(),
            mime_type: None,
        }];
        let r = assemble_call_result(content, false);
        assert_eq!(r.attachments[0].mime, "image/png");
        assert!(r.attachments[0].name.ends_with(".png"));
    }

    #[test]
    fn text_and_image_mix_preserves_both() {
        let content = vec![
            CallToolContent::Text { text: "before".to_string() },
            CallToolContent::Image { data: "eQ==".to_string(), mime_type: Some("image/png".to_string()) },
            CallToolContent::Text { text: "after".to_string() },
        ];
        let r = assemble_call_result(content, false);
        assert_eq!(r.attachments.len(), 1);
        assert!(r.content_text.contains("before"));
        assert!(r.content_text.contains("after"));
    }

    #[test]
    fn oversized_text_is_capped_with_marker() {
        let big = "a".repeat(MAX_TOOL_RESULT_TEXT_BYTES);
        let content = vec![
            CallToolContent::Text { text: big.clone() },
            CallToolContent::Text { text: big },
        ];
        let r = assemble_call_result(content, false);
        assert!(r.content_text.contains("truncated by Loach"));
    }

    #[test]
    fn empty_error_result_gets_placeholder_text() {
        let r = assemble_call_result(vec![], true);
        assert!(r.is_error);
        assert_eq!(r.content_text, "tool returned no content");
        assert!(r.attachments.is_empty());
    }

    #[test]
    fn resource_is_stringified() {
        let content = vec![CallToolContent::Resource {
            resource: Some(json!({ "uri": "file:///x", "text": "hi" })),
        }];
        let r = assemble_call_result(content, false);
        assert!(r.content_text.contains("file:///x"));
        assert!(r.attachments.is_empty());
    }

    /// A transport error goes to the model and the transcript, so it must
    /// not quote a URL that carries the server's credential.
    #[tokio::test]
    async fn a_failed_post_leaves_the_url_out_of_its_error() {
        // A server that hangs up without answering.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((conn, _)) = listener.accept().await {
                drop(conn);
            }
        });
        let url = format!("http://127.0.0.1:{port}/api/mcp/s/sk-secret-123/mcp");
        let session = McpSession::new(reqwest::Client::new(), &row(&url)).expect("session");
        let err = post_rpc_raw(&session, &json!({}))
            .await
            .expect_err("the server hung up");
        let shown = format!("{err:#}");
        assert!(shown.contains("POST to MCP server failed"), "{shown}");
        assert!(!shown.contains("sk-secret-123"), "{shown}");
    }

    fn row(url: &str) -> McpServer {
        McpServer {
            id: "t".into(),
            name: "t".into(),
            transport: "http".into(),
            url: url.into(),
            headers_json: None,
            command: None,
            args_json: None,
            env_json: None,
            auto_approve: false,
            allowed_tools_json: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// A whole HTTP/1.1 response, closing the connection after it.
    fn http(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// A local server for the transport tests. Each connection carries one
    /// request, answered with `respond(&request)`; every request it saw comes
    /// back on the channel, in the order they arrived.
    async fn mock_server(respond: fn(&str) -> String) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://127.0.0.1:{}/mcp", listener.local_addr().expect("addr").port());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut conn, _)) = listener.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    // The head, then as much body as it announces.
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let request = loop {
                        let n = match conn.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        raw.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&raw).into_owned();
                        let Some(head_end) = text.find("\r\n\r\n") else { continue };
                        let body_len = text[..head_end]
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
                            })
                            .unwrap_or(0);
                        if raw.len() >= head_end + 4 + body_len {
                            break text;
                        }
                    };
                    let _ = tx.send(request.clone());
                    let _ = conn.write_all(respond(&request).as_bytes()).await;
                });
            }
        });
        (url, rx)
    }

    /// A server may ask something of its own — a `ping` — on the stream
    /// ahead of the reply. It used to be taken for the reply; now it is
    /// answered with a POST of its own, and the wait goes on to the frame
    /// that carries the request's id.
    #[tokio::test]
    async fn a_ping_ahead_of_the_reply_is_answered_and_passed_over() {
        fn respond(request: &str) -> String {
            if !request.contains(r#""method":"tools/list""#) {
                return http("202 Accepted", "", "");
            }
            let frames = concat!(
                "data: {\"jsonrpc\":\"2.0\",\"id\":\"srv-1\",\"method\":\"ping\"}\n\n",
                "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\r\n\r\n",
                "data: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{}}\n\n",
                "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"a\"}]}}\n\n",
            );
            http("200 OK", "content-type: text/event-stream\r\n", frames)
        }
        let (url, mut seen) = mock_server(respond).await;
        let mut session = McpSession::new(reqwest::Client::new(), &row(&url)).expect("session");
        let tools = session.list_tools_raw().await.expect("the reply after the ping");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "a");

        let _list = seen.recv().await;
        let pong = tokio::time::timeout(Duration::from_secs(5), seen.recv())
            .await
            .expect("the ping was answered")
            .expect("a request");
        assert!(pong.contains(r#""id":"srv-1""#) && pong.contains(r#""result":{}"#), "{pong}");
    }

    /// After the handshake every request names the protocol version the
    /// server settled on, and a catalogue served in pages is read to its
    /// last page.
    #[tokio::test]
    async fn requests_after_initialize_carry_the_version_and_every_page_is_read() {
        fn respond(request: &str) -> String {
            let json = "content-type: application/json\r\n";
            if request.contains(r#""method":"initialize""#) {
                http("200 OK", json, r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}"#)
            } else if request.contains(r#""cursor":"p2""#) {
                http("200 OK", json, r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"b"}]}}"#)
            } else if request.contains(r#""method":"tools/list""#) {
                http(
                    "200 OK",
                    json,
                    r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"}],"nextCursor":"p2"}}"#,
                )
            } else {
                http("202 Accepted", "", "")
            }
        }
        let (url, mut seen) = mock_server(respond).await;
        let mut session = McpSession::new(reqwest::Client::new(), &row(&url)).expect("session");
        session.initialize().await.expect("handshake");
        let names: Vec<String> = session
            .list_tools_raw()
            .await
            .expect("both pages")
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, ["a", "b"]);

        let mut requests = Vec::new();
        while let Ok(r) = seen.try_recv() {
            requests.push(r.to_ascii_lowercase());
        }
        assert_eq!(requests.len(), 4, "initialize, initialized, two pages");
        assert!(!requests[0].contains("mcp-protocol-version"), "{}", requests[0]);
        for r in &requests[1..] {
            assert!(r.contains("mcp-protocol-version: 2025-03-26"), "{r}");
        }
    }

    /// A session the server handed out an id for is ended there — HTTP
    /// DELETE with that id — once Loach drops it.
    #[tokio::test]
    async fn dropping_a_session_ends_it_on_the_server() {
        fn respond(request: &str) -> String {
            if request.contains(r#""method":"initialize""#) {
                http(
                    "200 OK",
                    "content-type: application/json\r\nmcp-session-id: sess-42\r\n",
                    r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
                )
            } else {
                http("202 Accepted", "", "")
            }
        }
        let (url, mut seen) = mock_server(respond).await;
        let mut session = McpSession::new(reqwest::Client::new(), &row(&url)).expect("session");
        session.initialize().await.expect("handshake");
        drop(session);
        let delete = loop {
            let r = tokio::time::timeout(Duration::from_secs(5), seen.recv())
                .await
                .expect("a DELETE was sent")
                .expect("a request");
            if r.starts_with("DELETE") {
                break r;
            }
        };
        assert!(delete.to_ascii_lowercase().contains("mcp-session-id: sess-42"), "{delete}");
    }

    /// The tag rides as context, under more context at times; it must be
    /// found either way, or the pool's one safe retry never happens.
    #[test]
    fn the_pre_execution_tag_is_found_under_any_context() {
        let tagged = anyhow!("connection refused")
            .context("POST to MCP server failed")
            .context(PreExecutionFailure);
        assert!(is_pre_execution(&tagged));
        assert!(is_pre_execution(&tagged.context("MCP server `x`")));
        assert!(!is_pre_execution(&anyhow!("timed out").context("POST to MCP server failed")));
    }

    #[test]
    fn sse_frames_are_sorted_by_what_they_are_to_the_request() {
        let reply = r#"{"jsonrpc":"2.0","id":7,"result":{}}"#;
        assert_eq!(sse_frame(reply, Some(7)), SseFrame::Reply);
        assert_eq!(sse_frame(reply, Some(8)), SseFrame::Skip, "another request's reply");
        assert_eq!(
            sse_frame(r#"{"jsonrpc":"2.0","id":"s1","method":"ping"}"#, Some(7)),
            SseFrame::Answer(json!({ "jsonrpc": "2.0", "id": "s1", "result": {} }))
        );
        let progress = |token: i64| {
            json!({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": { "progressToken": token, "progress": 1 },
            })
            .to_string()
        };
        assert_eq!(sse_frame(&progress(7), Some(7)), SseFrame::Progress);
        assert_eq!(sse_frame(&progress(3), Some(7)), SseFrame::Skip);
        assert_eq!(
            sse_frame(r#"{"jsonrpc":"2.0","method":"notifications/message","params":{}}"#, Some(7)),
            SseFrame::Skip
        );
        // Unreadable, or an error without an id: the caller reports it.
        assert_eq!(sse_frame("not json", Some(7)), SseFrame::Reply);
        assert_eq!(
            sse_frame(r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}"#, Some(7)),
            SseFrame::Reply
        );
    }

    #[test]
    fn extract_first_sse_data_joins_lines_whatever_they_end_in() {
        assert_eq!(extract_first_sse_data("event: message\ndata: {\"a\":1}").as_deref(), Some("{\"a\":1}"));
        // A payload split over several `data:` lines is joined with `\n`.
        assert_eq!(extract_first_sse_data("data: {\"a\":\ndata: 1}").as_deref(), Some("{\"a\":\n1}"));
        assert_eq!(extract_first_sse_data("data: {\"a\":\r\ndata:1}\r\n").as_deref(), Some("{\"a\":\n1}"));
        assert_eq!(extract_first_sse_data("data: x\rdata: y").as_deref(), Some("x\ny"));
        // Only the first event's lines; comments and other fields ignored.
        assert_eq!(extract_first_sse_data(": hi\nid: 3\ndata: one\n\ndata: two").as_deref(), Some("one"));
        assert_eq!(extract_first_sse_data("event: ping\n: keep-alive"), None);
    }

    #[test]
    fn truncate_cuts_at_300_chars_on_a_char_boundary() {
        assert_eq!(truncate("short"), "short");
        let exact = "é".repeat(300);
        assert_eq!(truncate(&exact), exact);
        // Two-byte chars put byte 300 mid-char; the cut is by chars.
        let out = truncate(&"é".repeat(301));
        assert_eq!(out, format!("{}…", "é".repeat(300)));
    }

    /// The fix for the usual redirect is spelled out; any other target is
    /// named by its origin only, since its path can hold a credential.
    #[test]
    fn redirects_are_described_without_their_path() {
        let base = "https://mcp.example.com/api/s/sk-1/mcp";
        assert!(redirect_hint(base, "/api/s/sk-1/mcp/").unwrap().contains("add one"));
        assert!(redirect_hint("https://h.example/mcp/", "https://h.example/mcp")
            .unwrap()
            .contains("remove it"));
        let elsewhere = redirect_hint(base, "https://login.example.net/s/sk-2?next=1").unwrap();
        assert_eq!(elsewhere, "it redirects to https://login.example.net");
        let same_host = redirect_hint(base, "/v2/s/sk-1/mcp").unwrap();
        assert!(!same_host.contains("sk-1"), "{same_host}");
        assert_eq!(redirect_hint("not a url", "/x"), None);
    }

    #[test]
    fn image_content_deserialises_from_mcp_json() {
        // MCP servers send `type: "image"` with a camelCase `mimeType`.
        let parsed: CallToolContent =
            serde_json::from_value(json!({ "type": "image", "data": "Zm9v", "mimeType": "image/webp" }))
                .expect("image content parses");
        match parsed {
            CallToolContent::Image { data, mime_type } => {
                assert_eq!(data, "Zm9v");
                assert_eq!(mime_type.as_deref(), Some("image/webp"));
            }
            _ => panic!("expected Image variant"),
        }
    }
}
