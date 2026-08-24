use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::select;

use super::{resolve_qualified, ChatRequest, ModelInfo};
use crate::db::Database;
use crate::mcp::McpToolDef;
use crate::secrets;
use crate::sse::find_frame_end;
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

/// Per-tool-result ceiling fed back into the model. See the matching
/// constant in `providers::ollama` for the full rationale.
const MAX_TOOL_RESULT_BYTES: usize = 32 * 1024;

/// Ceiling on the number of parallel tool-call slots a single streamed turn
/// may allocate. The OpenAI wire protocol indexes parallel calls from 0; a
/// real turn issues a handful. The `index` is taken verbatim from the
/// (untrusted) server, and a single delta carrying e.g. `index: 2_000_000_000`
/// would otherwise drive `accum.resize_with(idx + 1, …)` into a multi-GB
/// allocation that aborts the whole process. Cap it so one hostile or buggy
/// frame can't turn into an OOM.
const MAX_TOOL_CALLS: usize = 256;

/// Ceiling on the total bytes accumulated into streamed tool-call names +
/// arguments across all slots in a turn. OpenAI streams the JSON arguments
/// string in deltas we concatenate; the per-frame `MAX_FRAME_BYTES` guard
/// resets every time a delimiter drains the buffer, so a server emitting an
/// unbounded run of small, well-formed frames could grow `accum` without
/// limit. 4 MiB is far above any realistic tool-call payload while keeping
/// the accumulation bounded.
const MAX_TOOL_CALL_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<OpenAIModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModel {
    id: String,
}

pub async fn list_models(http: &Client, base_url: &str) -> Result<Vec<ModelInfo>> {
    // Same defense-in-depth SSRF gate the chat-stream path uses. The
    // listing endpoint auto-fires from `modelsStore.refresh()` whenever
    // `openai_base_url` is moved off the public default — without this
    // guard, a corrupted settings row or a malicious snapshot import
    // could land a request on a cloud-metadata service on every refresh.
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut req = http.get(url).timeout(ADMIN_TIMEOUT);
    // Gate the bearer on transport safety exactly as the chat-stream path
    // does (`is_safe_for_bearer`): attach the key only over https or
    // http-to-loopback. Without this, pointing the OpenAI-compatible
    // provider at an `http://` LAN host — or a corrupted / imported
    // `openai_base_url` — would ship the key in cleartext on every
    // model-list refresh, the exact leak the chat path already prevents.
    // Off the runtime — blocking OS-keyring read (see chat_stream's note).
    if let Some(key) = tokio::task::spawn_blocking(secrets::get_openai_key).await?? {
        if !key.is_empty() && is_safe_for_bearer(base_url) {
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
    /// Present on the terminator frame for compat servers that omit the
    /// trailing `data: [DONE]` marker (Azure, some Ollama-OpenAI proxies).
    /// We treat any non-null `finish_reason` as an EOS so the chat doesn't
    /// hang waiting for a [DONE] that never arrives.
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
    /// Some servers emit a final, choices-empty chunk that carries
    /// `usage: { completion_tokens, prompt_tokens, total_tokens }`. When
    /// it shows up we use it for the metrics footer instead of the
    /// per-chunk fallback counter — that one increments once per
    /// non-empty delta, which biases TPS low for servers that batch
    /// multiple tokens per chunk.
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
struct Usage {
    #[serde(default)]
    completion_tokens: Option<u32>,
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
    cancel: Arc<tokio::sync::Notify>,
    req: ChatRequest,
) -> Result<()> {
    // Cancel Notify is registered upstream in `commands::chat_stream`.
    // See the matching note in providers/ollama.rs::chat_stream.
    let channel = event_channel(&req.stream_id);

    // Defense-in-depth SSRF guard. The shared HTTP client is intentionally
    // *not* DNS-pinned the way MCP's per-server clients are — hosted
    // providers and LAN llama-servers are both legitimate destinations.
    // The narrow thing we reject is link-local, because that range hosts
    // cloud-metadata services (AWS / GCP / Azure / DigitalOcean / Oracle
    // all live at 169.254.169.254) and no realistic LLM endpoint is
    // there.
    if let Err(e) = super::refuse_link_local_host(&req.base_url).await {
        let _ = app.emit(&channel, StreamEvent::Error { message: e });
        registry.finish(&req.stream_id);
        return Ok(());
    }

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

    // Read the OpenAI key ONCE for the whole stream, off the runtime.
    // `get_openai_key` is a blocking OS-keyring call (the commands.rs call
    // sites all wrap it in spawn_blocking); previously the provider read it
    // inline inside `run_one_turn`, i.e. once per tool-loop turn, on a tokio
    // worker that was concurrently pumping other streams' events. The key
    // can't legitimately change mid-conversation, so a single read is correct
    // and keeps that blocking call off the per-turn TTFT path.
    let api_key: Option<String> =
        tokio::task::spawn_blocking(|| secrets::get_openai_key().ok().flatten())
            .await
            .ok()
            .flatten();

    let start = Instant::now();
    let mut total_tokens: u32 = 0;
    // Authoritative token count from `usage.completion_tokens` if the
    // server volunteered it. Kept across turns so the final metrics
    // emit sees the last reported number (the chunk-counter is the
    // fallback when usage never arrives — e.g. older Ollama compat
    // shims that ignore `stream_options.include_usage`).
    let mut reported_tokens: Option<u32> = None;

    for turn in 0..MAX_TOOL_TURNS {
        // Keep the running history under the soft cap. The first turn is
        // typically a single user message and short; later turns
        // accumulate assistant + tool-result frames that grow fast.
        super::bound_messages_payload(&mut messages);

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            // Opt into the `usage` frame in streaming responses. Servers
            // that don't recognise this option (most pre-2024 compat
            // shims) silently ignore it; the ones that do return a
            // trailing choices-empty chunk with completion_tokens.
            "stream_options": { "include_usage": true },
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
            api_key.as_deref(),
            body,
            &mut total_tokens,
            &mut reported_tokens,
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
                // Prefer the provider's authoritative count when it
                // sent one; fall back to our chunk-counter approximation
                // for compat shims that don't honour `include_usage`.
                let tokens_for_metrics = reported_tokens.unwrap_or(total_tokens);
                emit_metrics(&app, &channel, tokens_for_metrics, start);
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
                    // Spec says `content` may be null when the assistant
                    // turn is purely tool calls. Strict gateways (Azure,
                    // some local OpenAI-compat proxies) 400 on empty
                    // strings here, so we use Null explicitly.
                    "content": Value::Null,
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
                                    attachments: Vec::new(),
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
                    let (content, is_error, attachments) = select! {
                        biased;
                        _ = cancel.notified() => {
                            let _ = app.emit(&channel, StreamEvent::Cancelled);
                            registry.finish(&req.stream_id);
                            return Ok(());
                        }
                        r = dispatch => match r {
                            Ok(r) => (r.content_text, r.is_error, r.attachments),
                            Err(e) => (format!("tool call failed: {e:#}"), true, Vec::new()),
                        },
                    };

                    // UI sees the full result; model only sees the cap.
                    let for_ui = content.clone();
                    let for_model = super::cap_tool_text(&content, MAX_TOOL_RESULT_BYTES);

                    let _ = app.emit(
                        &channel,
                        StreamEvent::ToolResult {
                            id: call_id.clone(),
                            content: for_ui,
                            is_error,
                            attachments,
                        },
                    );

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": for_model,
                    }));
                }
                // Loop — give the model the tool results and let it
                // continue.
            }
        }
    }

    let _ = app.emit(
        &channel,
        StreamEvent::Error {
            message: format!(
                "Stopped after {MAX_TOOL_TURNS} tool-use turns — the model kept asking \
                 for tools. Either it's stuck or the task needs more turns than Loach permits."
            ),
        },
    );
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
    api_key: Option<&str>,
    mut body: Value,
    total_tokens: &mut u32,
    reported_tokens: &mut Option<u32>,
    stream_id: &str,
    registry: &StreamRegistry,
) -> Result<Option<TurnOutcome>> {
    // Completion tokens reported for THIS turn. Folded into the caller's
    // running `reported_tokens` once, at every exit path below, so a server
    // that re-reports cumulative usage per chunk can't inflate the total.
    let mut turn_tokens: Option<u32> = None;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    // Built through a closure so the `stream_options` retry below can issue a
    // second, identically-authenticated request without duplicating the
    // bearer logic.
    let build_req = |b: &Value| {
        let mut r = http.post(&url).json(b);
        if let Some(key) = api_key {
            if !key.is_empty() && is_safe_for_bearer(base_url) {
                r = r.bearer_auth(key);
            }
        }
        r
    };
    let http_req = build_req(&body);
    // Track whether we had a key but chose not to send it over cleartext
    // so we can fold that hint into a 401/403 response — without it, the
    // user sees "OpenAI HTTP 401: Unauthorized" and has no idea their key
    // was withheld for transport-safety reasons. Open OpenAI-compatible
    // servers (LM Studio, llama-server, vLLM) typically don't require auth,
    // so we keep firing the request unauthenticated; only the
    // genuinely-auth-required path benefits from the augmented message.
    let mut bearer_withheld = false;
    if let Some(key) = api_key {
        if !key.is_empty() && !is_safe_for_bearer(base_url) {
            bearer_withheld = true;
            tracing::warn!(
                "Refusing to send OpenAI bearer token over cleartext to {} — \
                 change the base URL to https:// or accept that requests will be unauthenticated.",
                base_url
            );
        }
    }

    // Race the request against a cancel, exactly as the byte pump below
    // does. Awaiting `send()` bare left Stop inert for the whole connect +
    // header window — which on a queued or cold-starting endpoint can run to
    // tens of seconds — so the UI showed a stopped stream while the server
    // kept generating. Dropping the future closes the connection.
    let sent = select! {
        biased;
        _ = cancel.notified() => {
            let _ = app.emit(channel, StreamEvent::Cancelled);
            registry.finish(stream_id);
            return Ok(None);
        }
        r = http_req.send() => r,
    };
    let mut resp = match sent {
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

    // `stream_options` is opt-in usage telemetry, not something the chat
    // needs. A strict gateway that rejects unknown arguments would otherwise
    // fail the whole turn over a field the user never asked for — so on that
    // specific rejection, drop it and retry once. Mirrors the Ollama path's
    // `think` retry. Metrics fall back to the chunk counter afterwards.
    if resp.status() == reqwest::StatusCode::BAD_REQUEST
        && body.get("stream_options").is_some()
    {
        let text = resp.text().await.unwrap_or_default();
        if text.contains("stream_options") {
            tracing::warn!("server rejected `stream_options`; retrying without it");
            if let Some(obj) = body.as_object_mut() {
                obj.remove("stream_options");
            }
            let retried = select! {
                biased;
                _ = cancel.notified() => {
                    let _ = app.emit(channel, StreamEvent::Cancelled);
                    registry.finish(stream_id);
                    return Ok(None);
                }
                r = build_req(&body).send() => r,
            };
            resp = match retried {
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
        } else {
            // A 400 about something else. The body is already consumed, so
            // report it here rather than falling through to the block below.
            let _ = app.emit(
                channel,
                StreamEvent::Error {
                    message: format!("OpenAI HTTP 400 Bad Request: {text}"),
                },
            );
            registry.finish(stream_id);
            return Err(anyhow!("openai http error"));
        }
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // If the server rejected the request for auth reasons AND we
        // deliberately withheld the bearer because the base URL is cleartext
        // to a non-loopback host, surface the *why* — a bare "401" against
        // an OpenAI-compatible endpoint is otherwise indistinguishable from
        // a wrong key.
        let suffix = if bearer_withheld
            && (status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN)
        {
            " (API key withheld because the base URL is http:// to a non-loopback host — \
              switch to https:// to authenticate)"
        } else {
            ""
        };
        let _ = app.emit(
            channel,
            StreamEvent::Error {
                message: format!("OpenAI HTTP {status}: {text}{suffix}"),
            },
        );
        registry.finish(stream_id);
        return Err(anyhow!("openai http error"));
    }

    let mut byte_stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut scan_offset: usize = 0;
    let mut accum: Vec<AccumTool> = Vec::new();
    // Running total of bytes accumulated into streamed tool-call names +
    // arguments. Bounded by `MAX_TOOL_CALL_BYTES` in the loop so an untrusted
    // server can't grow `accum` without limit via a flood of small frames.
    let mut tool_call_bytes: usize = 0;

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
                            find_frame_end(&buf[scan_offset..])
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
                                let parsed = serde_json::from_str::<SseChunk>(data);
                                if let Err(e) = &parsed {
                                    // Don't drop malformed frames silently.
                                    // The Ollama pump logs its parse errors;
                                    // without the same here, a compat server
                                    // emitting a bad chunk was indistinguishable
                                    // from a model that just stopped talking.
                                    tracing::warn!(
                                        "OpenAI SSE: skipping unparseable frame ({e}): {}",
                                        data.chars().take(200).collect::<String>()
                                    );
                                }
                                if let Ok(parsed) = parsed {
                                    // OpenAI (and most compat servers)
                                    // emit a final choices-empty frame
                                    // carrying `usage`. When we see it,
                                    // remember the authoritative
                                    // completion-tokens number — emitted
                                    // alongside metrics on Done so the
                                    // footer TPS isn't biased by our
                                    // per-chunk approximation.
                                    if let Some(u) = parsed.usage {
                                        if let Some(n) = u.completion_tokens {
                                            // Snapshot THIS turn, overwriting
                                            // any earlier value from the same
                                            // response; the fold into
                                            // `reported_tokens` happens once,
                                            // when the turn ends.
                                            //
                                            // Adding here double-counted on
                                            // servers that stream a RUNNING
                                            // usage object across several
                                            // chunks (vLLM with
                                            // `continuous_usage_stats`, some
                                            // gateways), inflating the metrics
                                            // footer. The Ollama pump already
                                            // works this way.
                                            turn_tokens = Some(n);
                                        }
                                    }
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
                                                // OpenAI's wire protocol
                                                // always includes the
                                                // index. A compat server
                                                // that omits it confuses
                                                // multi-call assembly
                                                // (without `index` we
                                                // can't tell which slot
                                                // a delta belongs to) —
                                                // log and skip rather
                                                // than silently collapse
                                                // every call into slot 0.
                                                let Some(idx_raw) = tc.index else {
                                                    tracing::warn!(
                                                        "openai stream: tool_call delta has no `index`; \
                                                         skipping frame to avoid collapsing into slot 0"
                                                    );
                                                    continue;
                                                };
                                                let idx = idx_raw as usize;
                                                // `index` is untrusted server
                                                // input — cap it so a single
                                                // frame can't drive `resize_with`
                                                // into a process-aborting OOM.
                                                if idx >= MAX_TOOL_CALLS {
                                                    tracing::warn!(
                                                        "openai stream: tool_call index {idx} exceeds \
                                                         the {MAX_TOOL_CALLS}-slot cap; skipping"
                                                    );
                                                    continue;
                                                }
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
                                                        tool_call_bytes += n.len();
                                                        slot.name.push_str(&n);
                                                    }
                                                    if let Some(a) = f.arguments {
                                                        tool_call_bytes += a.len();
                                                        slot.arguments.push_str(&a);
                                                    }
                                                }
                                                // Bound the total accumulated
                                                // tool-call payload across every
                                                // slot — the per-frame guard
                                                // doesn't catch a flood of small
                                                // well-formed frames. Abort the
                                                // turn the same way an oversized
                                                // frame does.
                                                if tool_call_bytes > MAX_TOOL_CALL_BYTES {
                                                    let _ = app.emit(
                                                        channel,
                                                        StreamEvent::Error {
                                                            message: format!(
                                                                "tool-call arguments exceeded {} bytes — aborting",
                                                                MAX_TOOL_CALL_BYTES
                                                            ),
                                                        },
                                                    );
                                                    registry.finish(stream_id);
                                                    return Err(anyhow!("openai tool-call payload too large"));
                                                }
                                            }
                                        }
                                        // Treat any non-null finish_reason
                                        // as EOS for compat servers that
                                        // skip the trailing [DONE] frame.
                                        // We still let the current chunk's
                                        // deltas accumulate (they may carry
                                        // the last tokens or tool-call
                                        // pieces) — the `finished` flag
                                        // only takes effect once the
                                        // outer frame loop finishes.
                                        if c.finish_reason.is_some() {
                                            finished = true;
                                        }
                                    }
                                }
                            }
                            if finished { break; }
                        }
                        // The longest SSE frame separator is `\r\n\r\n`
                        // (4 bytes), so keep that many bytes of overlap
                        // for the next scan to catch a separator that
                        // straddles the chunk boundary.
                        scan_offset = buf.len().saturating_sub(4);
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
                            // Fold this turn's reported usage into the
                            // running total exactly once.
                            if let Some(n) = turn_tokens {
                                *reported_tokens =
                                    Some(reported_tokens.unwrap_or(0).saturating_add(n));
                            }
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
                        // Stream ended without an explicit terminator — same
                        // fold as the `finished` path above.
                        if let Some(n) = turn_tokens {
                            *reported_tokens =
                                Some(reported_tokens.unwrap_or(0).saturating_add(n));
                        }
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

/// Parse a model-emitted tool-call argument string. The protocol promises
/// JSON, but models occasionally emit unquoted keys, trailing commas, or
/// Python-style `None` — when that happens we fall through to handing
/// the raw text to the dispatcher as a string, which keeps the call
/// alive (the tool will see a malformed input and can complain in its
/// error reply, which the model then has a chance to react to).
///
/// We log the parse failure so a user looking at `RUST_LOG=debug` traces
/// for "why does this tool always seem to fail" gets a clear signal
/// without us turning the silent fallback into a hard error.
fn parse_args(s: &str) -> Value {
    if s.trim().is_empty() {
        return json!({});
    }
    match serde_json::from_str(s) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "openai tool call: arguments are not valid JSON ({e}); forwarding raw text"
            );
            Value::String(s.to_string())
        }
    }
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
            // `Url::host_str` keeps the `[ ]` brackets on IPv6 addresses —
            // strip them before parsing or `http://[::1]` is never
            // recognised as loopback and silently loses its auth header
            // (same dance as `refuse_link_local_host` in providers/mod.rs).
            let host = host
                .strip_prefix('[')
                .and_then(|s| s.strip_suffix(']'))
                .unwrap_or(host);
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
    } else if trimmed.starts_with("UklGR") && trimmed.len() >= 16 {
        // RIFF layout: "RIFF" at bytes 0..4, the little-endian size at 4..8,
        // "WEBP" at 8..12. Base64 packs 3 bytes into 4 chars, so chars 12..16
        // always encode bytes 9..12 — "EBP" — which is invariant across file
        // sizes and encodes to exactly "RUJQ".
        //
        // The previous check looked for "V0VC" (base64 of "WEB") anywhere in
        // chars 12..24, which no real WebP can contain: "WEB" starts at byte
        // 8, and 8 % 3 == 2, so it never lands on a base64 group boundary.
        // Every genuine WebP therefore fell through and was announced to the
        // provider as `image/png`.
        //
        // `b64` is untrusted (frontend-supplied, not guaranteed valid
        // base64), so `get(..)` rather than `[..]` — a multi-byte UTF-8
        // sequence straddling an index would otherwise panic. A real WebP
        // header is pure ASCII, so a non-boundary slice means it isn't one
        // and `None` correctly falls through.
        if trimmed.get(12..16) == Some("RUJQ") {
            "image/webp"
        } else {
            "image/png"
        }
    } else {
        "image/png"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- is_safe_for_bearer -------------------------------------------------
    // A regression here silently leaks the user's API key over cleartext
    // HTTP, so pin both directions of the decision table.

    #[test]
    fn bearer_allowed_on_https_anywhere() {
        assert!(is_safe_for_bearer("https://api.openai.com/v1"));
        assert!(is_safe_for_bearer("https://192.168.1.50:8080"));
    }

    #[test]
    fn bearer_allowed_on_http_loopback_only() {
        assert!(is_safe_for_bearer("http://localhost:8080/v1"));
        assert!(is_safe_for_bearer("http://LOCALHOST:8080")); // case-insensitive
        assert!(is_safe_for_bearer("http://ip6-localhost:8080"));
        assert!(is_safe_for_bearer("http://127.0.0.1:1234"));
        assert!(is_safe_for_bearer("http://[::1]:8080"));
    }

    #[test]
    fn bearer_dropped_on_http_to_non_loopback() {
        // LAN hosts are still cleartext transport — a sniffer on the local
        // network reads the key. Only loopback is exempt.
        assert!(!is_safe_for_bearer("http://192.168.1.50:8080"));
        assert!(!is_safe_for_bearer("http://api.example.com/v1"));
        assert!(!is_safe_for_bearer("http://10.0.0.5:11434"));
    }

    #[test]
    fn bearer_dropped_on_unparseable_or_odd_schemes() {
        assert!(!is_safe_for_bearer("not a url"));
        assert!(!is_safe_for_bearer(""));
        assert!(!is_safe_for_bearer("ftp://127.0.0.1/"));
    }

    // --- sniff_image_mime ---------------------------------------------------

    #[test]
    fn sniff_detects_common_formats() {
        assert_eq!(sniff_image_mime("iVBORw0KGgo="), "image/png");
        assert_eq!(sniff_image_mime("/9j/4AAQSkZJRg=="), "image/jpeg");
        assert_eq!(sniff_image_mime("R0lGODlhAQ=="), "image/gif");
        // Leading whitespace is tolerated (trim_start).
        assert_eq!(sniff_image_mime("  iVBORw0KGgo="), "image/png");
        // Unknown content falls back to png.
        assert_eq!(sniff_image_mime("QUJDREVG"), "image/png");
    }

    /// Built from real RIFF/WebP bytes rather than a hand-written base64
    /// string. The previous version of this test asserted against
    /// "UklGRAAAAAAAV0VCAAAAAAAA" — a string no encoder can produce — which
    /// is why it kept passing while every actual WebP was announced as PNG.
    #[test]
    fn sniff_detects_real_webp_headers() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let webp_header = |size: u32, fourcc: &[u8; 4]| {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(b"RIFF");
            bytes.extend_from_slice(&size.to_le_bytes());
            bytes.extend_from_slice(b"WEBP");
            bytes.extend_from_slice(fourcc);
            bytes.extend_from_slice(&[0u8; 8]);
            STANDARD.encode(bytes)
        };

        // The declared size occupies bytes 4..8 and so varies per file; the
        // detector must not depend on it. Same for the codec fourcc.
        for size in [0u32, 26, 1024, 4_000_000, u32::MAX] {
            for fourcc in [b"VP8 ", b"VP8L", b"VP8X"] {
                let b64 = webp_header(size, fourcc);
                assert_eq!(
                    sniff_image_mime(&b64),
                    "image/webp",
                    "size={size} fourcc={} b64={b64}",
                    String::from_utf8_lossy(fourcc),
                );
            }
        }

        // A RIFF container that is NOT WebP (e.g. a WAV) must not claim to be.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&36u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&[0u8; 8]);
        assert_eq!(sniff_image_mime(&STANDARD.encode(wav)), "image/png");

        // RIFF prefix with no usable header at all.
        assert_eq!(sniff_image_mime(&format!("UklGR{}", "A".repeat(19))), "image/png");
        // Too short to carry a fourcc.
        assert_eq!(sniff_image_mime("UklGRAAA"), "image/png");
    }

    #[test]
    fn sniff_survives_non_boundary_utf8() {
        // Regression for the byte-slice panic: `b64` is frontend-supplied
        // and not guaranteed valid base64, so a multi-byte char straddling
        // index 12 or 16 must fall through, not panic. "UklGR" is 5 bytes;
        // each "é" is 2, so chars start at 5,7,9,11,13… and byte 12 lands
        // mid-char.
        let evil = format!("UklGR{}", "é".repeat(12));
        assert_eq!(sniff_image_mime(&evil), "image/png");
    }

    // --- parse_args -----------------------------------------------------------

    #[test]
    fn parse_args_empty_means_no_arguments() {
        assert_eq!(parse_args(""), json!({}));
        assert_eq!(parse_args("   "), json!({}));
    }

    #[test]
    fn parse_args_valid_json_parses() {
        assert_eq!(parse_args(r#"{"city":"Oslo","n":2}"#), json!({"city": "Oslo", "n": 2}));
    }

    #[test]
    fn parse_args_malformed_json_forwarded_as_raw_string() {
        // Models occasionally emit unquoted keys / Python None; the call must
        // stay alive with the raw text, not be dropped.
        let v = parse_args("{city: Oslo}");
        assert_eq!(v, Value::String("{city: Oslo}".into()));
    }

    // --- decide_outcome -------------------------------------------------------

    #[test]
    fn decide_outcome_drops_half_formed_tool_calls() {
        // Streamed deltas with index N can leave earlier slots name-less.
        // Those are debris and would error on dispatch — only named calls
        // survive, and an all-debris turn is Done, not Tools([]).
        let accum = vec![
            AccumTool { id: None, name: String::new(), arguments: String::new() },
            AccumTool { id: Some("call_1".into()), name: "get_weather".into(), arguments: "{}".into() },
        ];
        match decide_outcome(accum) {
            TurnOutcome::Tools(valid) => {
                assert_eq!(valid.len(), 1);
                assert_eq!(valid[0].name, "get_weather");
            }
            TurnOutcome::Done => panic!("named call must survive"),
        }

        let debris = vec![AccumTool { id: None, name: String::new(), arguments: "{}".into() }];
        assert!(matches!(decide_outcome(debris), TurnOutcome::Done));
        assert!(matches!(decide_outcome(vec![]), TurnOutcome::Done));
    }
}
