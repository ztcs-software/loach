use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::select;

use super::{ChatRequest, ModelInfo};
use crate::db::Database;
use crate::mcp::McpToolDef;
use crate::secrets;
use crate::stream::{event_channel, StreamEvent, StreamRegistry};

/// Per-frame ceiling on the SSE buffer between blank-line delimiters. Mirrors
/// `providers::ollama::MAX_LINE_BYTES`. A reasonable OpenAI chunk is sub-KB;
/// 1 MiB is generous while still catching a stream that never delivers a
/// frame separator (broken proxy, HTML error page mid-stream, etc.).
const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Wall-clock ceiling for `list_models`. The shared `reqwest::Client` has
/// no default timeout (the chat-stream path needs unbounded time for long
/// generations), so admin calls supply their own. 30 s is well above any
/// healthy /models response.
const ADMIN_TIMEOUT: Duration = Duration::from_secs(30);

/// Same rationale as `providers::ollama::MAX_TOOL_TURNS` — cap multi-turn
/// tool use so a confused model can't pin the chat in an infinite loop.
const MAX_TOOL_TURNS: u32 = 10;

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<OpenAIModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModel {
    id: String,
}

pub async fn list_models(http: &Client, base_url: &str) -> Result<Vec<ModelInfo>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut req = http.get(url).timeout(ADMIN_TIMEOUT);
    if let Some(key) = secrets::get_openai_key()? {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }
    let resp = req.send().await?.error_for_status()?;
    let body: ModelsResponse = resp.json().await?;
    Ok(body
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id.clone(),
            label: m.id,
            provider: "openai".into(),
            family: None,
            size: None,
        })
        .collect())
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Option<DeltaMsg>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeltaMsg {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<DeltaToolCall>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    /// SSE deltas carry a stable index for the tool call slot so multi-tool
    /// turns assemble correctly even when their fields stream out of order.
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<DeltaToolFn>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolFn {
    #[serde(default)]
    name: Option<String>,
    /// OpenAI streams the JSON arguments string in deltas — we concatenate
    /// before parsing.
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SseChunk {
    #[serde(default)]
    choices: Vec<Choice>,
}

/// Accumulated tool call across a single turn — `name` and `arguments` may
/// arrive in pieces over many SSE frames. We close over them with the
/// `index` from the delta.
#[derive(Debug, Clone)]
struct AccumTool {
    id: Option<String>,
    name: String,
    arguments: String,
}

fn build_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    if let Some(sys) = req.system_prompt.as_deref() {
        if !sys.is_empty() {
            out.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        let role = match m.role.as_str() {
            "assistant" => "assistant",
            "system" => "system",
            _ => "user",
        };
        let content: Value = if m.images.is_empty() {
            Value::String(m.content.clone())
        } else {
            let mut parts: Vec<Value> = Vec::new();
            if !m.content.is_empty() {
                parts.push(json!({ "type": "text", "text": m.content }));
            }
            for img in &m.images {
                let mime = sniff_image_mime(img);
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{mime};base64,{img}") }
                }));
            }
            Value::Array(parts)
        };
        out.push(json!({ "role": role, "content": content }));
    }
    out
}

enum TurnOutcome {
    Done,
    Tools(Vec<AccumTool>),
}

pub async fn chat_stream(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    db: Arc<Database>,
    req: ChatRequest,
) -> Result<()> {
    let cancel = registry.register(req.stream_id.clone());
    let channel = event_channel(&req.stream_id);

    let mut messages = build_messages(&req);

    let tools_json: Option<Value> = if req.tools.is_empty() {
        None
    } else {
        Some(json!(req
            .tools
            .iter()
            .map(openai_tool_def)
            .collect::<Vec<_>>()))
    };

    let start = Instant::now();
    let mut total_tokens: u32 = 0;

    for turn in 0..MAX_TOOL_TURNS {
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(v) = req.params.temperature {
            body["temperature"] = json!(v);
        }
        if let Some(v) = req.params.top_p {
            body["top_p"] = json!(v);
        }
        if let Some(v) = req.params.max_tokens {
            body["max_tokens"] = json!(v);
        }
        if let Some(v) = req.params.frequency_penalty {
            body["frequency_penalty"] = json!(v);
        }
        if let Some(v) = req.params.presence_penalty {
            body["presence_penalty"] = json!(v);
        }
        if let Some(v) = req.params.seed {
            body["seed"] = json!(v);
        }
        if let Some(tools) = tools_json.as_ref() {
            body["tools"] = tools.clone();
        }

        let outcome = match run_one_turn(
            &app,
            &http,
            &req.base_url,
            &channel,
            &cancel,
            body,
            &mut total_tokens,
            &req.stream_id,
            &registry,
        )
        .await?
        {
            Some(o) => o,
            None => return Ok(()),
        };

        match outcome {
            TurnOutcome::Done => {
                emit_metrics(&app, &channel, total_tokens, start);
                let _ = app.emit(&channel, StreamEvent::Done);
                registry.finish(&req.stream_id);
                return Ok(());
            }
            TurnOutcome::Tools(calls) => {
                // Assistant turn carrying the tool calls. OpenAI requires
                // the tool_calls array (with `id` and the `function` object)
                // and a `content` field that may be empty when the model
                // immediately reached for a tool.
                let oa_calls: Vec<Value> = calls
                    .iter()
                    .enumerate()
                    .map(|(idx, c)| {
                        let id = c.id.clone().unwrap_or_else(|| format!("call_{turn}_{idx}"));
                        json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": c.name,
                                "arguments": c.arguments,
                            }
                        })
                    })
                    .collect();
                messages.push(json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": oa_calls,
                }));

                for (idx, call) in calls.iter().enumerate() {
                    let call_id = call
                        .id
                        .clone()
                        .unwrap_or_else(|| format!("call_{turn}_{idx}"));
                    let (tool_def, tool_name) = match resolve_qualified(&req.tools, &call.name) {
                        Some(pair) => pair,
                        None => {
                            let msg = format!(
                                "unknown tool `{}` — server may have been disabled",
                                call.name
                            );
                            let _ = app.emit(
                                &channel,
                                StreamEvent::ToolResult {
                                    id: call_id.clone(),
                                    content: msg.clone(),
                                    is_error: true,
                                },
                            );
                            messages.push(json!({
                                "role": "tool",
                                "tool_call_id": call_id,
                                "content": msg,
                            }));
                            continue;
                        }
                    };

                    let args = parse_args(&call.arguments);

                    let _ = app.emit(
                        &channel,
                        StreamEvent::ToolCall {
                            id: call_id.clone(),
                            server_id: tool_def.server_id.clone(),
                            server_name: tool_def.server_name.clone(),
                            tool: tool_def.qualified_name.clone(),
                            arguments: args.clone(),
                        },
                    );

                    let dispatch = crate::mcp::dispatch_tool_call(
                        &db,
                        &tool_def.server_id,
                        &tool_name,
                        &args,
                    );
                    let (content, is_error) = select! {
                        biased;
                        _ = cancel.notified() => {
                            let _ = app.emit(&channel, StreamEvent::Cancelled);
                            registry.finish(&req.stream_id);
                            return Ok(());
                        }
                        r = dispatch => match r {
                            Ok(r) => (r.content_text, r.is_error),
                            Err(e) => (format!("tool call failed: {e:#}"), true),
                        },
                    };

                    let _ = app.emit(
                        &channel,
                        StreamEvent::ToolResult {
                            id: call_id.clone(),
                            content: content.clone(),
                            is_error,
                        },
                    );

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": content,
                    }));
                }
                // Loop — give the model the tool results and let it
                // continue.
            }
        }
    }

    let _ = app.emit(
        &channel,
        StreamEvent::Token {
            delta: format!(
                "\n\n_⚠ Stopped after {MAX_TOOL_TURNS} tool-use turns. The model kept asking for tools — \
                 either it's stuck in a loop or the task genuinely needs more turns than Loach permits._"
            ),
        },
    );
    emit_metrics(&app, &channel, total_tokens, start);
    let _ = app.emit(&channel, StreamEvent::Done);
    registry.finish(&req.stream_id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_one_turn(
    app: &AppHandle,
    http: &Client,
    base_url: &str,
    channel: &str,
    cancel: &Arc<tokio::sync::Notify>,
    body: Value,
    total_tokens: &mut u32,
    stream_id: &str,
    registry: &StreamRegistry,
) -> Result<Option<TurnOutcome>> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut http_req = http.post(&url).json(&body);
    if let Some(key) = secrets::get_openai_key().ok().flatten() {
        if !key.is_empty() {
            if is_safe_for_bearer(base_url) {
                http_req = http_req.bearer_auth(key);
            } else {
                tracing::warn!(
                    "Refusing to send OpenAI bearer token over cleartext to {} — \
                     change the base URL to https:// or accept that requests will be unauthenticated.",
                    base_url
                );
            }
        }
    }

    let resp = match http_req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                channel,
                StreamEvent::Error {
                    message: format!("OpenAI request failed: {e}"),
                },
            );
            registry.finish(stream_id);
            return Err(e.into());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            channel,
            StreamEvent::Error {
                message: format!("OpenAI HTTP {status}: {text}"),
            },
        );
        registry.finish(stream_id);
        return Err(anyhow!("openai http error"));
    }

    let mut byte_stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut scan_offset: usize = 0;
    let mut accum: Vec<AccumTool> = Vec::new();

    loop {
        select! {
            biased;
            _ = cancel.notified() => {
                drop(byte_stream);
                let _ = app.emit(channel, StreamEvent::Cancelled);
                registry.finish(stream_id);
                return Ok(None);
            }
            maybe = byte_stream.next() => {
                match maybe {
                    Some(Ok(chunk)) => {
                        buf.extend_from_slice(&chunk);
                        if buf.len() > MAX_FRAME_BYTES && find_frame_end(&buf).is_none() {
                            let _ = app.emit(
                                channel,
                                StreamEvent::Error {
                                    message: format!(
                                        "stream exceeded {} bytes without a frame delimiter — aborting",
                                        MAX_FRAME_BYTES
                                    ),
                                },
                            );
                            registry.finish(stream_id);
                            return Err(anyhow!("openai stream frame too large"));
                        }

                        let mut pending_token = String::new();
                        let mut pending_think = String::new();
                        let mut finished = false;
                        while let Some((rel_pos, sep_len)) =
                            find_frame_end_with_len(&buf[scan_offset..])
                        {
                            let pos = scan_offset + rel_pos;
                            let frame: Vec<u8> = buf.drain(..pos + sep_len).collect();
                            scan_offset = 0;
                            let text = String::from_utf8_lossy(
                                &frame[..frame.len() - sep_len],
                            )
                            .to_string();
                            for line in text.lines() {
                                let line = line.trim_start();
                                if !line.starts_with("data:") { continue; }
                                let data = line[5..].trim_start();
                                if data == "[DONE]" {
                                    finished = true;
                                    break;
                                }
                                if let Ok(parsed) = serde_json::from_str::<SseChunk>(data) {
                                    for c in parsed.choices {
                                        if let Some(d) = c.delta {
                                            if let Some(think) = d.reasoning_content {
                                                if !think.is_empty() {
                                                    pending_think.push_str(&think);
                                                }
                                            }
                                            if let Some(delta) = d.content {
                                                if !delta.is_empty() {
                                                    *total_tokens += 1;
                                                    pending_token.push_str(&delta);
                                                }
                                            }
                                            for tc in d.tool_calls {
                                                let idx = tc.index.unwrap_or(0) as usize;
                                                if accum.len() <= idx {
                                                    accum.resize_with(idx + 1, || AccumTool {
                                                        id: None,
                                                        name: String::new(),
                                                        arguments: String::new(),
                                                    });
                                                }
                                                let slot = &mut accum[idx];
                                                if let Some(id) = tc.id {
                                                    slot.id = Some(id);
                                                }
                                                if let Some(f) = tc.function {
                                                    if let Some(n) = f.name {
                                                        slot.name.push_str(&n);
                                                    }
                                                    if let Some(a) = f.arguments {
                                                        slot.arguments.push_str(&a);
                                                    }
                                                }
                                            }
                                        }
                                        if c.finish_reason.is_some() {
                                            // Some servers omit [DONE]; treat
                                            // a finish_reason as terminator
                                            // too, but only on the next loop
                                            // turn — the same chunk may still
                                            // carry deltas we want to flush.
                                        }
                                    }
                                }
                            }
                            if finished { break; }
                        }
                        scan_offset = buf.len().saturating_sub(3);
                        if !pending_think.is_empty() {
                            let _ = app.emit(
                                channel,
                                StreamEvent::Thinking { delta: pending_think },
                            );
                        }
                        if !pending_token.is_empty() {
                            let _ = app.emit(
                                channel,
                                StreamEvent::Token { delta: pending_token },
                            );
                        }
                        if finished {
                            return Ok(Some(decide_outcome(accum)));
                        }
                    }
                    Some(Err(e)) => {
                        let _ = app.emit(
                            channel,
                            StreamEvent::Error { message: format!("stream error: {e}") },
                        );
                        registry.finish(stream_id);
                        return Err(e.into());
                    }
                    None => {
                        return Ok(Some(decide_outcome(accum)));
                    }
                }
            }
        }
    }
}

fn decide_outcome(accum: Vec<AccumTool>) -> TurnOutcome {
    // Filter out half-formed entries — a streamed delta with index N may
    // have left empty slots in earlier indexes that the model never
    // populated. Those are debris and would error on dispatch.
    let valid: Vec<AccumTool> = accum
        .into_iter()
        .filter(|t| !t.name.is_empty())
        .collect();
    if valid.is_empty() {
        TurnOutcome::Done
    } else {
        TurnOutcome::Tools(valid)
    }
}

fn emit_metrics(app: &AppHandle, channel: &str, tokens: u32, start: Instant) {
    let elapsed = start.elapsed().as_millis() as u64;
    let tps = if elapsed > 0 {
        (tokens as f64) * 1000.0 / (elapsed as f64)
    } else {
        0.0
    };
    let _ = app.emit(
        channel,
        StreamEvent::Metrics {
            tokens,
            elapsed_ms: elapsed,
            tokens_per_second: tps,
        },
    );
}

fn openai_tool_def(def: &McpToolDef) -> Value {
    let mut function = serde_json::Map::new();
    function.insert("name".into(), json!(def.qualified_name));
    if let Some(desc) = def.description.as_deref() {
        function.insert(
            "description".into(),
            json!(format!("[{}] {desc}", def.server_name)),
        );
    } else {
        function.insert("description".into(), json!(format!("[{}]", def.server_name)));
    }
    function.insert("parameters".into(), def.input_schema.clone());
    json!({ "type": "function", "function": function })
}

fn parse_args(s: &str) -> Value {
    if s.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(s).unwrap_or_else(|_| Value::String(s.to_string()))
}

fn resolve_qualified<'a>(
    tools: &'a [McpToolDef],
    qualified: &str,
) -> Option<(&'a McpToolDef, String)> {
    let def = tools.iter().find(|t| t.qualified_name == qualified)?;
    Some((def, def.name.clone()))
}

/// Decide whether it's safe to attach a bearer token to a request going
/// to `base_url`. Safe iff:
///   - the URL is https://, OR
///   - the URL is http:// and the host is a loopback address (local
///     OpenAI-compat servers like LocalAI typically listen on
///     127.0.0.1:8080 with no TLS).
///
/// Anything else — http:// to an external host — is treated as
/// untrusted transport and we drop the auth header to avoid leaking the
/// user's API key over cleartext.
fn is_safe_for_bearer(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => {
            let Some(host) = url.host_str() else {
                return false;
            };
            if host.eq_ignore_ascii_case("localhost")
                || host.eq_ignore_ascii_case("ip6-localhost")
            {
                return true;
            }
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                return ip.is_loopback();
            }
            false
        }
        _ => false,
    }
}

fn sniff_image_mime(b64: &str) -> &'static str {
    let trimmed = b64.trim_start();
    if trimmed.starts_with("iVBORw") {
        "image/png"
    } else if trimmed.starts_with("/9j/") {
        "image/jpeg"
    } else if trimmed.starts_with("R0lGOD") {
        "image/gif"
    } else if trimmed.starts_with("UklGR") && trimmed.len() >= 24 {
        if trimmed[12..24].contains("V0VC") {
            "image/webp"
        } else {
            "image/png"
        }
    } else {
        "image/png"
    }
}

fn find_frame_end_with_len(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n");
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(a), Some(b)) => {
            if a <= b {
                Some((a, 2))
            } else {
                Some((b, 4))
            }
        }
        (Some(a), None) => Some((a, 2)),
        (None, Some(b)) => Some((b, 4)),
        (None, None) => None,
    }
}

fn find_frame_end(buf: &[u8]) -> Option<usize> {
    find_frame_end_with_len(buf).map(|(pos, _)| pos)
}
