use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version we claim to speak. MCP is still evolving; this matches
/// the version the reference clients were using at time of writing. Servers
/// that don't support exactly this version usually negotiate down.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

// ---------- JSON-RPC 2.0 framing ----------
//
// Requests / notifications are built with `serde_json::json!(...)` in the
// HTTP client rather than dedicated structs — the on-wire shape is small
// enough that the literal is easier to read than a type. Only the response
// side is strongly typed because we have to pattern-match on `result` vs
// `error`.

#[derive(Debug, Deserialize)]
pub struct JsonRpcResponse {
    #[allow(dead_code)]
    pub jsonrpc: Option<String>,
    // `id` is only read when a transport has to pair replies to pending
    // requests (stdio did). Streamable-HTTP is one-POST-one-reply so we
    // don't inspect it, but keep the field for Debug output.
    #[allow(dead_code)]
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[allow(dead_code)]
    #[serde(default)]
    pub data: Option<Value>,
}

// ---------- MCP-specific payloads ----------

#[derive(Debug, Deserialize)]
pub struct InitializeResult {
    #[serde(default, rename = "protocolVersion")]
    pub protocol_version: Option<String>,
    #[serde(default, rename = "serverInfo")]
    pub server_info: Option<ServerInfo>,
}

#[derive(Debug, Deserialize)]
pub struct ServerInfo {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListToolsResult {
    #[serde(default)]
    pub tools: Vec<McpToolRaw>,
}

#[derive(Debug, Deserialize)]
pub struct McpToolRaw {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

// ---------- Public result shape (serialized to the frontend) ----------

/// What the Settings UI gets back from "Test connection". `ok` is true only
/// when the handshake *and* the tools/list call both succeed. On failure,
/// `error` carries a human-readable reason.
#[derive(Debug, Serialize, Clone)]
pub struct McpTestResult {
    pub ok: bool,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub protocol_version: Option<String>,
    pub tools: Vec<McpTool>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
}

impl McpTestResult {
    pub fn failure(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            server_name: None,
            server_version: None,
            protocol_version: None,
            tools: Vec::new(),
            error: Some(msg.into()),
        }
    }
}
