use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use crate::db::McpServer;

use super::types::{
    JsonRpcError, JsonRpcResponse, ListToolsResult, InitializeResult, McpTestResult, McpTool,
    PROTOCOL_VERSION,
};

/// Per-request ceiling. Remote MCP servers can take a few seconds to cold
/// start (especially gateway-backed ones), so we give each JSON-RPC call
/// 30 s before giving up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const CLIENT_NAME: &str = "loach";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Probe an MCP server: handshake + list tools. Never panics; any failure
/// is packaged into `McpTestResult::failure`.
pub async fn test_server(server: &McpServer, http: &reqwest::Client) -> McpTestResult {
    match test_http(server, http).await {
        Ok(r) => r,
        Err(e) => McpTestResult::failure(format!("{e:#}")),
    }
}

// ---------- HTTP (streamable) ----------

async fn test_http(server: &McpServer, http: &reqwest::Client) -> Result<McpTestResult> {
    let url = server.url.trim();
    if url.is_empty() {
        bail!("MCP server URL is empty");
    }
    let headers: HashMap<String, String> = match server.headers_json.as_deref() {
        Some(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).context("headers_json is not a JSON object of strings")?
        }
        _ => HashMap::new(),
    };

    // Streamable HTTP can return a session id on initialize which subsequent
    // requests need to echo back. Track it so we stay "logged in" for the
    // tools/list call.
    let mut session_id: Option<String> = None;

    // ---- initialize ----
    let init = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
        },
    });
    let (init_resp, sid) = post_rpc(http, url, &headers, &init, session_id.as_deref()).await?;
    session_id = sid;
    let init_val: InitializeResult = unwrap_response(init_resp)?;

    // ---- initialized notification ----
    let note = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    });
    // Notifications carry no id; the server may reply 202 with no body, so
    // ignore parse errors here.
    let _ = post_rpc_raw(http, url, &headers, &note, session_id.as_deref()).await;

    // ---- tools/list ----
    let list = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
    });
    let (list_resp, _) = post_rpc(http, url, &headers, &list, session_id.as_deref()).await?;
    let tools: ListToolsResult = unwrap_response(list_resp)?;

    Ok(McpTestResult {
        ok: true,
        server_name: init_val.server_info.as_ref().and_then(|s| s.name.clone()),
        server_version: init_val
            .server_info
            .as_ref()
            .and_then(|s| s.version.clone()),
        protocol_version: init_val.protocol_version,
        tools: tools
            .tools
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
    let text = resp.text().await.context("read MCP server response")?;

    if !status.is_success() {
        bail!("server responded with HTTP {}: {}", status, truncate(&text));
    }

    // Streamable HTTP may push its JSON inside the first `data:` frame of an
    // SSE stream. Pull it out if we spot the event-stream MIME.
    let payload = if content_type.contains("text/event-stream") {
        extract_first_sse_data(&text)
            .ok_or_else(|| anyhow!("event-stream response contained no data frame"))?
            .to_string()
    } else {
        text
    };

    Ok((payload, sid))
}

fn extract_first_sse_data(s: &str) -> Option<&str> {
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            return Some(rest.trim_start());
        }
    }
    None
}

fn truncate(s: &str) -> String {
    const MAX: usize = 300;
    if s.len() <= MAX {
        s.to_string()
    } else {
        format!("{}…", &s[..MAX])
    }
}
