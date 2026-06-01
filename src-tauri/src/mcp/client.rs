use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::db::McpServer;

use super::types::{
    Attachment, CallToolContent, CallToolResult, InitializeResult, JsonRpcError, JsonRpcResponse,
    ListToolsResult, McpCallResult, McpTestResult, McpTool, McpToolRaw, PROTOCOL_VERSION,
};

/// Per-request ceiling. Remote MCP servers can take a few seconds to cold
/// start (especially gateway-backed ones), so we give each JSON-RPC call
/// 30 s before giving up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// Monotonic JSON-RPC `id` counter. Streamable HTTP is one-POST-one-
    /// reply so we don't pair replies to pending requests, but a fresh id
    /// per call keeps the logs and any server-side telemetry sane.
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
        let (resp, sid) = post_rpc(
            &self.http,
            &self.url,
            &self.headers,
            &init,
            self.session_id.as_deref(),
        )
        .await?;
        if let Some(s) = accept_session_id(sid) {
            self.session_id = Some(s);
        }
        let parsed: InitializeResult = unwrap_response(resp)?;

        // Best-effort initialized notification. Some servers (notably the
        // GitHub gateway) require this before they'll honour tools/* calls.
        let note = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        let _ = post_rpc_raw(
            &self.http,
            &self.url,
            &self.headers,
            &note,
            self.session_id.as_deref(),
        )
        .await;

        Ok(parsed)
    }

    /// Fetch the full tool catalog. Returns the raw shape (includes the
    /// JSON-Schema for each tool's arguments) so callers that need to
    /// forward schemas to an LLM don't lose them.
    pub async fn list_tools_raw(&mut self) -> Result<Vec<McpToolRaw>> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": self.fresh_id(),
            "method": "tools/list",
        });
        let (resp, sid) = post_rpc(
            &self.http,
            &self.url,
            &self.headers,
            &body,
            self.session_id.as_deref(),
        )
        .await?;
        if let Some(s) = accept_session_id(sid) {
            self.session_id = Some(s);
        }
        let parsed: ListToolsResult = unwrap_response(resp)?;
        Ok(parsed.tools)
    }

    /// Invoke a single tool. Returns the concatenated text content + the
    /// server's `isError` flag. `arguments` is a JSON object the model
    /// constructed against the tool's input schema; we forward it verbatim
    /// without validating against the schema (the server will reject
    /// invalid shapes itself and the model will react to the error).
    pub async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<McpCallResult> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": self.fresh_id(),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments,
            },
        });
        let (resp, sid) = post_rpc(
            &self.http,
            &self.url,
            &self.headers,
            &body,
            self.session_id.as_deref(),
        )
        .await?;
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
}

/// Fold a tool's content array into the result we hand the provider layer:
/// text pieces concatenated under a running byte cap, `Image` content
/// surfaced as image attachments (the frontend renders them inline rather
/// than dropping them to a placeholder), and resources stringified with a
/// per-item cap. Pure and allocation-bounded so it's unit-testable without
/// a live server.
fn assemble_call_result(content: Vec<CallToolContent>, is_error: bool) -> McpCallResult {
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
            CallToolContent::Unknown => {
                // Drop unknown variants rather than fabricate text —
                // the model can still react to the rest of the
                // content array.
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

fn unwrap_response<T: serde::de::DeserializeOwned>(resp: JsonRpcResponse) -> Result<T> {
    if let Some(err) = resp.error {
        bail!(format_rpc_error(&err));
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
    http: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    body: &Value,
    session: Option<&str>,
) -> Result<(JsonRpcResponse, Option<String>)> {
    let (raw, sid) = post_rpc_raw(http, url, headers, body, session).await?;
    let parsed: JsonRpcResponse = serde_json::from_str(&raw)
        .with_context(|| format!("server sent invalid JSON-RPC frame: {raw}"))?;
    Ok((parsed, sid))
}

async fn post_rpc_raw(
    http: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    body: &Value,
    session: Option<&str>,
) -> Result<(String, Option<String>)> {
    let mut req = http
        .post(url)
        .header("Content-Type", "application/json")
        // Streamable HTTP servers can reply with either JSON or SSE; tell
        // them we'll accept either so we get the most compatible response.
        .header("Accept", "application/json, text/event-stream")
        .json(body)
        .timeout(REQUEST_TIMEOUT);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(s) = session {
        req = req.header("Mcp-Session-Id", s);
    }

    let resp = req.send().await.context("POST to MCP server failed")?;
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
    let text = read_capped_text(resp)
        .await
        .context("read MCP server response")?;

    if !status.is_success() {
        bail!("server responded with HTTP {}: {}", status, truncate(&text));
    }

    // Streamable HTTP may push its JSON inside the first `data:` frame of an
    // SSE stream. Pull it out if we spot the event-stream MIME.
    let payload = if content_type.contains("text/event-stream") {
        extract_first_sse_data(&text)
            .ok_or_else(|| anyhow!("event-stream response contained no data frame"))?
    } else {
        text
    };

    Ok((payload, sid))
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
    // line) and join them.
    let mut data: Vec<&str> = Vec::new();
    for line in s.lines() {
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
