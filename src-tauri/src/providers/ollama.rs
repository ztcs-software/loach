use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::select;

use super::{ChatRequest, ModelInfo};
use crate::db::Database;
use crate::mcp::McpToolDef;
use crate::stream::{admin_channel, event_channel, AdminEvent, StreamEvent, StreamRegistry};

/// Per-line ceiling for the NDJSON / SSE pump. A well-behaved provider sends
/// frames in the low-kilobytes range; this cap is generous enough to fit any
/// realistic Ollama progress / chat chunk while still catching a stream that
/// never delivers a newline (broken proxy, ratelimit page, etc.) before it
/// fills memory.
const MAX_LINE_BYTES: usize = 1024 * 1024; // 1 MiB

/// Per-request ceiling for admin calls (show / delete / copy / probe /
/// list_models / unload / preload). The shared `reqwest::Client` in
/// `AppState` is built without a default timeout because the chat-stream
/// path needs unbounded wall-clock for long generations — so admin calls
/// have to apply their own. 30 s is well above any healthy local Ollama
/// response and short enough that the UI doesn't appear hung if the
/// server is wedged. Pull / create are streamed and skip this cap; their
/// progress events keep the user informed.
const ADMIN_TIMEOUT: Duration = Duration::from_secs(30);
/// Shorter wall-clock for the "is Ollama up?" health check. A real Ollama
/// answers `/api/tags` in single-digit ms; if we have to wait 5 s the
/// answer for UX purposes is "no, treat it as down".
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Hard ceiling on tool-use turns in a single chat request. The first turn
/// is the user's prompt → model reply; each subsequent turn is one
/// "model called tools → we executed → model continues" round trip. 10
/// is enough for any plausible chain (browse-then-summarise, multi-step
/// repo investigation) and short enough that a confused model can't loop
/// forever calling the same tool.
const MAX_TOOL_TURNS: u32 = 10;

/// Per-tool-result ceiling fed back into the next chat turn. MCP responses
/// can legitimately be tens of kilobytes (a `list_issues` page, a file
/// read, …) but the client-side cap on the raw HTTP body is 4 MiB. Push
/// a 4 MiB blob into `messages` and the next round-trip blows the model's
/// context window — across 10 turns the conversation could carry 40 MiB
/// of in-flight strings before anyone sees the bill. Truncate per call,
/// tell the model it was truncated so it can decide whether to ask for
/// a different slice.
const MAX_TOOL_RESULT_BYTES: usize = 32 * 1024;

/// Hard ceiling on tool calls accumulated in a single turn. Mirrors the
/// OpenAI path's cap, for the same reason: the model server is untrusted.
const MAX_TOOL_CALLS: usize = 256;

// ---------------------------------------------------------------------------
// Model admin: show / delete / copy / pull / create
// ---------------------------------------------------------------------------
//
// These wrap the `/api/show`, `/api/delete`, `/api/copy`, `/api/pull` and
// `/api/create` endpoints. The long-running ones (pull / create) stream
// NDJSON progress frames which we re-emit as `AdminEvent::Progress` events
// on the `admin://{stream_id}` channel. Everything that mutates local state
// is gated by the user — the Models panel invokes these explicitly.

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OllamaShowResponse {
    /// Current `Modelfile` (the plain-text recipe the model was built from).
    /// Useful for both display and as a starting point when deriving a new
    /// model — we prefill the editor with these values.
    #[serde(default)]
    pub modelfile: Option<String>,
    #[serde(default)]
    pub parameters: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    /// Detail sub-object — families, parameter_size, quantization_level, etc.
    #[serde(default)]
    pub details: Option<serde_json::Value>,
    /// `model_info` is a k/v map with things like
    /// `general.parameter_count`, `llama.context_length`, etc.
    #[serde(default)]
    pub model_info: Option<serde_json::Value>,
    /// Capability tags reported by newer Ollama versions:
    /// `["completion", "tools", "thinking", "vision", …]`. Older Ollama
    /// builds omit the field — `default` makes us tolerant of that. The
    /// frontend uses this to gate features like the "Thinking" toggle.
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
}

pub async fn show_model(
    http: &Client,
    base_url: &str,
    name: &str,
) -> Result<OllamaShowResponse> {
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/api/show", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "name": name });
    let resp = http
        .post(url)
        .json(&body)
        .timeout(ADMIN_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let parsed: OllamaShowResponse = resp.json().await?;
    Ok(parsed)
}

pub async fn delete_model(http: &Client, base_url: &str, name: &str) -> Result<()> {
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/api/delete", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "name": name });
    let resp = http
        .delete(url)
        .json(&body)
        .timeout(ADMIN_TIMEOUT)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ollama delete failed ({status}): {text}"));
    }
    Ok(())
}

pub async fn copy_model(
    http: &Client,
    base_url: &str,
    source: &str,
    destination: &str,
) -> Result<()> {
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/api/copy", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "source": source,
        "destination": destination,
    });
    let resp = http
        .post(url)
        .json(&body)
        .timeout(ADMIN_TIMEOUT)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ollama copy failed ({status}): {text}"));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ProgressChunk {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

/// Shared NDJSON pump used by pull / create. Re-emits every line as an
/// `AdminEvent::Progress` over the `admin://{stream_id}` channel.
///
/// Cancellation goes through the shared `StreamRegistry`: the frontend can
/// call `chat_cancel` (wrong name, same registry) — or a dedicated
/// `admin_cancel` command — to stop mid-download.
async fn drive_progress_stream(
    app: AppHandle,
    registry: StreamRegistry,
    stream_id: String,
    url: String,
    body: serde_json::Value,
    http: Client,
    cancel: Arc<tokio::sync::Notify>,
) -> Result<()> {
    // `cancel` is registered by the command BEFORE it spawns us — see
    // `ollama_pull_model`. Registering here (as this function used to) left
    // a window covering task scheduling plus `refuse_link_local_host`'s DNS
    // resolution during which `admin_cancel` found an empty registry and was
    // silently dropped, so the download ran on regardless.
    let channel = admin_channel(&stream_id);

    // Race the request against a cancel the same way the byte pump below
    // does. Without this, a Stop pressed while Ollama is still deciding to
    // answer does nothing until headers arrive.
    let resp = tokio::select! {
        biased;
        _ = cancel.notified() => {
            let _ = app.emit(&channel, AdminEvent::Cancelled);
            registry.finish(&stream_id);
            return Ok(());
        }
        r = http.post(&url).json(&body).send() => r,
    };
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                &channel,
                AdminEvent::Error {
                    message: format!("Ollama request failed: {e}"),
                },
            );
            registry.finish(&stream_id);
            return Err(e.into());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            &channel,
            AdminEvent::Error {
                message: format!("Ollama HTTP {status}: {text}"),
            },
        );
        registry.finish(&stream_id);
        return Err(anyhow!("ollama http error"));
    }

    let mut byte_stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    loop {
        select! {
            biased;
            _ = cancel.notified() => {
                // Explicitly drop the response stream BEFORE returning so
                // reqwest closes the underlying TCP connection right away.
                // If we just `return Ok(())`, the stream is still dropped
                // by stack unwind, but doing it here makes the intent
                // obvious and guarantees the connection close happens
                // before any further work on the calling task — which
                // gives the server-side pull the earliest possible chance
                // to notice the client gave up and abort the download.
                drop(byte_stream);
                let _ = app.emit(&channel, AdminEvent::Cancelled);
                registry.finish(&stream_id);
                return Ok(());
            }
            maybe = byte_stream.next() => {
                match maybe {
                    Some(Ok(chunk)) => {
                        buf.extend_from_slice(&chunk);
                        // Guard against a stream that never delivers a newline
                        // (broken proxy, HTML 5xx page, etc.). Cap the buffer
                        // between newlines so it can't grow without bound.
                        if buf.len() > MAX_LINE_BYTES && !buf.contains(&b'\n') {
                            let _ = app.emit(
                                &channel,
                                AdminEvent::Error {
                                    message: format!(
                                        "stream exceeded {} bytes without a frame delimiter — aborting",
                                        MAX_LINE_BYTES
                                    ),
                                },
                            );
                            registry.finish(&stream_id);
                            return Err(anyhow!("ollama admin stream frame too large"));
                        }
                        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let line = &line[..line.len() - 1];
                            if line.is_empty() { continue; }
                            match serde_json::from_slice::<ProgressChunk>(line) {
                                Ok(parsed) => {
                                    if let Some(err) = parsed.error {
                                        let _ = app.emit(
                                            &channel,
                                            AdminEvent::Error { message: err },
                                        );
                                        registry.finish(&stream_id);
                                        return Ok(());
                                    }
                                    let status = parsed.status.unwrap_or_else(|| "working".into());
                                    let done_now = status == "success";
                                    let _ = app.emit(
                                        &channel,
                                        AdminEvent::Progress {
                                            status,
                                            digest: parsed.digest,
                                            total: parsed.total,
                                            completed: parsed.completed,
                                        },
                                    );
                                    if done_now {
                                        let _ = app.emit(&channel, AdminEvent::Done);
                                        registry.finish(&stream_id);
                                        return Ok(());
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("ollama admin parse error: {e}");
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        let _ = app.emit(
                            &channel,
                            AdminEvent::Error { message: format!("stream error: {e}") },
                        );
                        registry.finish(&stream_id);
                        return Err(e.into());
                    }
                    None => {
                        // Body ended without an explicit `{"status":"success"}` —
                        // treat EOF as a successful completion so callers don't
                        // hang forever on a silently-closed connection.
                        let _ = app.emit(&channel, AdminEvent::Done);
                        registry.finish(&stream_id);
                        return Ok(());
                    }
                }
            }
        }
    }
}

pub async fn pull_model(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    base_url: &str,
    name: &str,
    stream_id: String,
    cancel: Arc<tokio::sync::Notify>,
) -> Result<()> {
    if let Err(e) = super::refuse_link_local_host(base_url).await {
        // Mirror the shape of an in-flight admin failure: emit an Error
        // event on the admin channel and finish the registry slot so the
        // UI sees the same teardown path as a network failure.
        let _ = app.emit(
            &admin_channel(&stream_id),
            AdminEvent::Error { message: e },
        );
        registry.finish(&stream_id);
        return Ok(());
    }
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "name": name, "stream": true });
    drive_progress_stream(app, registry, stream_id, url, body, http, cancel).await
}

pub async fn create_model(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    base_url: &str,
    name: &str,
    modelfile: &str,
    stream_id: String,
    cancel: Arc<tokio::sync::Notify>,
) -> Result<()> {
    if let Err(e) = super::refuse_link_local_host(base_url).await {
        let _ = app.emit(
            &admin_channel(&stream_id),
            AdminEvent::Error { message: e },
        );
        registry.finish(&stream_id);
        return Ok(());
    }
    let url = format!("{}/api/create", base_url.trim_end_matches('/'));
    // Ollama 0.3+ supports `modelfile` as a field on `/api/create` so we
    // don't need to write a temp file. `stream: true` keeps the NDJSON
    // progress frames flowing.
    let body = serde_json::json!({
        "name": name,
        "modelfile": modelfile,
        "stream": true,
    });
    drive_progress_stream(app, registry, stream_id, url, body, http, cancel).await
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Debug, Deserialize)]
struct TagModel {
    name: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    details: Option<TagDetails>,
}

#[derive(Debug, Deserialize)]
struct TagDetails {
    #[serde(default)]
    family: Option<String>,
}

pub async fn probe(http: &Client, base_url: &str) -> bool {
    // SSRF guard: refuse to probe link-local even though `probe` returns
    // a bool. Without this the renderer could call `ollama_probe` against
    // 169.254.169.254 (or fe80::/10) and use the boolean response as a
    // cheap detector for a reachable cloud-metadata service.
    if super::refuse_link_local_host(base_url).await.is_err() {
        return false;
    }
    http.get(format!("{}/api/tags", base_url.trim_end_matches('/')))
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub async fn list_models(http: &Client, base_url: &str) -> Result<Vec<ModelInfo>> {
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = http
        .get(url)
        .timeout(ADMIN_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let body: TagsResponse = resp.json().await?;
    Ok(body
        .models
        .into_iter()
        .map(|m| ModelInfo {
            id: m.name.clone(),
            label: m.name,
            provider: "ollama".into(),
            family: m.details.and_then(|d| d.family),
            size: m.size,
        })
        .collect())
}

/// Unload a model from VRAM by sending an empty chat with keep_alive=0.
pub async fn unload_model(http: &Client, base_url: &str, model: &str) -> Result<()> {
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [],
        "stream": false,
        "keep_alive": 0,
    });
    // Unlike `preload_model`, this is an explicit user action from the
    // Models panel — swallowing the outcome reported success no matter what
    // happened (connection refused, unknown model, HTTP 500), so the UI
    // cheerfully said "unloaded" while the model stayed resident.
    let resp = http
        .post(url)
        .json(&body)
        .timeout(ADMIN_TIMEOUT)
        .send()
        .await
        .map_err(|e| anyhow!("couldn't reach Ollama to unload `{model}`: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama refused to unload `{model}` (HTTP {status}): {text}"));
    }
    Ok(())
}

/// Preload a model into VRAM by sending an empty chat. `keep_alive` controls
/// how long Ollama keeps it resident after the warm completes — pass the
/// user's configured value so the model survives until their first real
/// request even if that's more than Ollama's built-in 5-minute default away
/// (`None` falls back to that default). Errors are swallowed — preload is
/// best-effort and must never block app startup if Ollama is unreachable or
/// the model is missing.
pub async fn preload_model(
    http: &Client,
    base_url: &str,
    model: &str,
    keep_alive: Option<Value>,
    options: Option<Value>,
) -> Result<()> {
    super::refuse_link_local_host(base_url)
        .await
        .map_err(|e| anyhow!(e))?;
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "messages": [],
        "stream": false,
    });
    if let Some(ka) = keep_alive {
        body["keep_alive"] = ka;
    }
    // Warm the runner with the same options the first real request will send
    // (num_ctx above all) so Ollama doesn't have to reallocate the KV cache —
    // i.e. reload the model — on that first message.
    if let Some(opts) = options {
        body["options"] = opts;
    }
    // Preload can legitimately take longer than ADMIN_TIMEOUT for large
    // models (a 70 B model cold-loading from disk easily exceeds 30 s),
    // so give it a more generous ceiling. Still bounded so a wedged
    // Ollama can't hang the loader forever.
    let _ = http
        .post(url)
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct OllamaChunk {
    #[serde(default)]
    message: Option<OllamaChunkMsg>,
    #[serde(default)]
    done: bool,
    /// Authoritative token count from the trailing `done: true` chunk.
    /// Ollama only populates this on the final frame; intermediate
    /// chunks leave it None. Preferred over our per-chunk approximation
    /// (`total_tokens += 1` per non-empty content delta) because the
    /// chunk counter undercounts when a single chunk carries multiple
    /// tokens — which happens routinely on faster local models.
    #[serde(default)]
    eval_count: Option<u32>,
    /// Pure decode time in nanoseconds from the final `done: true` chunk
    /// (`eval_duration`). Paired with `eval_count` it gives the true generation
    /// rate — unlike wall-clock, which also folds in model load, prompt
    /// evaluation, and tool round-trips. `None` on intermediate chunks and on
    /// builds that don't report it.
    #[serde(default)]
    eval_duration: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OllamaChunkMsg {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    /// Tool calls a tool-capable model emits. Ollama places them on the
    /// final chunk (where `done: true`), not interleaved with content
    /// tokens, so we only need to inspect them once per turn.
    #[serde(default)]
    tool_calls: Vec<OllamaToolCall>,
}

#[derive(Debug, Deserialize, Clone)]
struct OllamaToolCall {
    #[serde(default)]
    function: Option<OllamaToolFn>,
}

#[derive(Debug, Deserialize, Clone)]
struct OllamaToolFn {
    name: String,
    /// Ollama returns this as a parsed JSON object; some forks return a
    /// stringified JSON. `Value` covers both shapes — we re-stringify if
    /// needed before forwarding to the MCP server.
    #[serde(default)]
    arguments: Value,
}

/// Outcome of one provider round-trip. `Done` means the model returned a
/// terminal reply (no more tool calls); `Tools` means the model wants us
/// to run tools and call back with the results.
enum TurnOutcome {
    Done,
    Tools(Vec<OllamaToolCall>),
}

pub async fn chat_stream(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    db: Arc<Database>,
    cancel: Arc<tokio::sync::Notify>,
    req: ChatRequest,
) -> Result<()> {
    // The cancel Notify is already registered upstream in
    // `commands::chat_stream` — we receive the handle directly rather
    // than re-registering, so cancels arriving during the pre-stream
    // MCP aggregation phase aren't lost.
    let channel = event_channel(&req.stream_id);

    // Defense-in-depth SSRF guard. Identical rationale to the OpenAI
    // path — reject link-local addresses (cloud-metadata services live
    // there) while allowing loopback, RFC 1918, CGNAT, and public IPs.
    if let Err(e) = super::refuse_link_local_host(&req.base_url).await {
        let _ = app.emit(&channel, StreamEvent::Error { message: e });
        registry.finish(&req.stream_id);
        return Ok(());
    }

    // Seed the running conversation with system prompt + the messages the
    // frontend handed us. We mutate this list as the multi-turn tool loop
    // runs — each turn appends an assistant message (possibly with
    // tool_calls) and any tool reply messages — so the next /api/chat call
    // sees the full history.
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = req.system_prompt.as_deref() {
        if !sys.is_empty() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        let mut msg = json!({ "role": m.role, "content": m.content });
        if !m.images.is_empty() {
            msg["images"] = json!(m.images);
        }
        messages.push(msg);
    }

    let tools_json: Option<Value> = if req.tools.is_empty() {
        None
    } else {
        Some(json!(req
            .tools
            .iter()
            .map(ollama_tool_def)
            .collect::<Vec<_>>()))
    };

    // How long Ollama should keep this model resident after the request.
    // Read once per stream from the global setting and sent on every turn so
    // each round-trip resets the idle timer. Unset → omit the field and let
    // Ollama apply its 5-minute default (Loach's pre-setting behaviour).
    let keep_alive: Option<Value> = db
        .get_setting("ollama_keep_alive")
        .ok()
        .flatten()
        .as_deref()
        .and_then(keep_alive_value);

    let start = Instant::now();
    let mut total_tokens: u32 = 0;
    let mut think_already_drop: bool = false; // sticky retry guard across turns
    // Authoritative token count from Ollama's final `done: true` chunk
    // (`eval_count`). Preferred over the per-chunk approximation —
    // faster local models routinely batch several tokens per chunk.
    let mut reported_tokens: Option<u32> = None;
    // Accumulated decode time (eval_duration, ns) across turns, paired with
    // reported_tokens to compute an accurate generation rate at the end.
    let mut reported_eval_ns: Option<u64> = None;

    for turn in 0..MAX_TOOL_TURNS {
        // Keep the running history under the soft cap before each turn.
        super::bound_messages_payload(&mut messages);

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "options": build_options(&req),
        });
        if let Some(ka) = keep_alive.as_ref() {
            body["keep_alive"] = ka.clone();
        }
        if let Some(t) = req.params.think {
            if !think_already_drop {
                body["think"] = json!(t);
            }
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
            &mut body,
            &mut total_tokens,
            &mut reported_tokens,
            &mut reported_eval_ns,
            &mut think_already_drop,
            &req.stream_id,
            &registry,
        )
        .await?
        {
            Some(o) => o,
            // Cancellation already drained — nothing more to do.
            None => return Ok(()),
        };

        match outcome {
            TurnOutcome::Done => {
                let tokens_for_metrics = reported_tokens.unwrap_or(total_tokens);
                emit_metrics(&app, &channel, tokens_for_metrics, reported_eval_ns, start);
                let _ = app.emit(&channel, StreamEvent::Done);
                registry.finish(&req.stream_id);
                return Ok(());
            }
            TurnOutcome::Tools(calls) => {
                // Append the assistant turn including the tool_calls block,
                // so subsequent /api/chat calls see the full conversation.
                // We use `Value::Null` for content (rather than "") because
                // strict OpenAI-compat gateways reject empty strings here;
                // recent Ollama accepts both, so Null is the safer choice.
                messages.push(json!({
                    "role": "assistant",
                    "content": Value::Null,
                    "tool_calls": calls
                        .iter()
                        .map(serialise_tool_call)
                        .collect::<Vec<_>>(),
                }));

                for (idx, call) in calls.iter().enumerate() {
                    let Some(func) = call.function.as_ref() else {
                        continue;
                    };
                    let call_id = format!("call_{turn}_{idx}");
                    let (tool_def, tool_name) = match resolve_qualified(&req.tools, &func.name) {
                        Some(pair) => pair,
                        None => {
                            let msg = format!(
                                "unknown tool `{}` — server may have been disabled",
                                func.name
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
                                // Ollama's documented field is `name`;
                                // `tool_name` is accepted by recent builds
                                // but older deploys ignore it (and then
                                // mis-thread the tool reply). Send `name`
                                // and include `tool_name` as a belt-and-
                                // braces alias.
                                "name": func.name,
                                "tool_name": func.name,
                                "content": msg,
                            }));
                            continue;
                        }
                    };

                    let args = normalise_args(&func.arguments);

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

                    // Honour cancellation while the tool runs — a slow
                    // MCP server (e.g. GitHub at peak hours, or a tool
                    // that does its own long fetch) shouldn't lock the
                    // user into waiting once they hit Stop.
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

                    // Cap what we feed back to the model. The UI gets the
                    // original (cap-free) string so users can still
                    // inspect the full result; only the message turn that
                    // re-enters the model is truncated.
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
                        "name": func.name,
                        "tool_name": func.name,
                        "content": for_model,
                    }));
                }
                // Fall through — loop again to give the model the tool
                // results and let it continue.
            }
        }
    }

    // Hit the turn cap. Emit Error rather than Token+Done so the frontend's
    // `finishRunning` is called with `reason: "error"` — that skips the
    // memory-extractor pass we'd otherwise run on a half-finished turn.
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

/// Run a single /api/chat round-trip. Streams tokens + thinking deltas, and
/// returns whether the model wants more tool calls (`Tools`) or has reached
/// a terminal answer (`Done`). `None` means we exited via cancellation and
/// the caller should stop immediately.
#[allow(clippy::too_many_arguments)]
async fn run_one_turn(
    app: &AppHandle,
    http: &Client,
    base_url: &str,
    channel: &str,
    cancel: &Arc<tokio::sync::Notify>,
    body: &mut Value,
    total_tokens: &mut u32,
    reported_tokens: &mut Option<u32>,
    reported_eval_ns: &mut Option<u64>,
    think_already_drop: &mut bool,
    stream_id: &str,
    registry: &StreamRegistry,
) -> Result<Option<TurnOutcome>> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    // Race the request against a cancel. Ollama withholds response headers
    // until the model is loaded — routinely 30–120 s for a large cold model —
    // and the chat client deliberately carries no request timeout, so
    // awaiting `send()` bare made Stop a no-op for that entire window: the
    // permit sat in the registry, the UI kept spinning, and the server
    // carried on loading and generating. Dropping the in-flight future
    // closes the connection immediately.
    let sent = select! {
        biased;
        _ = cancel.notified() => {
            let _ = app.emit(channel, StreamEvent::Cancelled);
            registry.finish(stream_id);
            return Ok(None);
        }
        r = http.post(&url).json(body).send() => r,
    };
    let mut resp = match sent {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                channel,
                StreamEvent::Error {
                    message: format!("Ollama request failed: {e}"),
                },
            );
            registry.finish(stream_id);
            return Err(e.into());
        }
    };

    // Safety net: older Ollama builds don't advertise the "thinking"
    // capability in /api/show, so we can't always know up front whether
    // the model supports it. If the server rejects the request
    // specifically because the model doesn't support thinking, drop the
    // flag (and remember not to re-add it on the next turn) and retry
    // once before giving up.
    if !resp.status().is_success() && body.get("think").is_some() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if text.contains("does not support thinking") {
            if let Some(obj) = body.as_object_mut() {
                obj.remove("think");
            }
            *think_already_drop = true;
            // Race the retry against cancel too. This is *the* request most
            // likely to sit for a minute-plus — it's the one that triggers a
            // cold model load — so awaiting it bare made Stop inert for the
            // whole window, which is exactly what the select! above exists
            // to prevent.
            let retried = select! {
                biased;
                _ = cancel.notified() => {
                    let _ = app.emit(channel, StreamEvent::Cancelled);
                    registry.finish(stream_id);
                    return Ok(None);
                }
                r = http.post(&url).json(body).send() => r,
            };
            resp = match retried {
                Ok(r) => r,
                Err(e) => {
                    let _ = app.emit(
                        channel,
                        StreamEvent::Error {
                            message: format!("Ollama request failed: {e}"),
                        },
                    );
                    registry.finish(stream_id);
                    return Err(e.into());
                }
            };
        } else {
            let _ = app.emit(
                channel,
                StreamEvent::Error {
                    message: format!("Ollama HTTP {status}: {text}"),
                },
            );
            registry.finish(stream_id);
            return Err(anyhow!("ollama http error"));
        }
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            channel,
            StreamEvent::Error {
                message: format!("Ollama HTTP {status}: {text}"),
            },
        );
        registry.finish(stream_id);
        return Err(anyhow!("ollama http error"));
    }

    let mut byte_stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut pending_tool_calls: Vec<OllamaToolCall> = Vec::new();
    // Per-turn eval_count snapshot, overwritten as chunks report it.
    // Ollama emits the canonical value on the final `done: true` chunk;
    // some older / forked builds emit running totals on intermediate
    // chunks too. Overwriting (not accumulating) is right within a turn —
    // we fold the final per-turn value into the session total only
    // when the turn ends, so multi-turn tool use doesn't double-count
    // and a forked build's intermediate emissions don't inflate the
    // count either.
    let mut turn_eval: Option<u32> = None;
    let mut turn_eval_duration: Option<u64> = None;

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
                        if buf.len() > MAX_LINE_BYTES && !buf.contains(&b'\n') {
                            let _ = app.emit(
                                channel,
                                StreamEvent::Error {
                                    message: format!(
                                        "stream exceeded {} bytes without a frame delimiter — aborting",
                                        MAX_LINE_BYTES
                                    ),
                                },
                            );
                            registry.finish(stream_id);
                            return Err(anyhow!("ollama chat stream frame too large"));
                        }

                        let mut pending_token = String::new();
                        let mut pending_think = String::new();
                        let mut finished = false;
                        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let line = &line[..line.len() - 1];
                            if line.is_empty() { continue; }
                            match serde_json::from_slice::<OllamaChunk>(line) {
                                Ok(parsed) => {
                                    if let Some(n) = parsed.eval_count {
                                        turn_eval = Some(n);
                                    }
                                    if let Some(d) = parsed.eval_duration {
                                        turn_eval_duration = Some(d);
                                    }
                                    if let Some(msg) = parsed.message {
                                        if let Some(think) = msg.thinking {
                                            if !think.is_empty() {
                                                pending_think.push_str(&think);
                                            }
                                        }
                                        if let Some(delta) = msg.content {
                                            if !delta.is_empty() {
                                                *total_tokens += 1;
                                                pending_token.push_str(&delta);
                                            }
                                        }
                                        if !msg.tool_calls.is_empty() {
                                            // Bounded like the OpenAI path's
                                            // MAX_TOOL_CALLS. The model server
                                            // is untrusted input, and every
                                            // entry here becomes a dispatched
                                            // call — a network round-trip plus
                                            // two events, run serially.
                                            let room = MAX_TOOL_CALLS
                                                .saturating_sub(pending_tool_calls.len());
                                            if room == 0 {
                                                tracing::warn!(
                                                    "ollama: tool-call flood — dropping {} past the {MAX_TOOL_CALLS} cap",
                                                    msg.tool_calls.len()
                                                );
                                            } else {
                                                pending_tool_calls.extend(
                                                    msg.tool_calls.into_iter().take(room),
                                                );
                                            }
                                        }
                                    }
                                    if parsed.done {
                                        finished = true;
                                        break;
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("ollama parse error: {e}");
                                }
                            }
                        }
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
                            // Fold this turn's reported count (if any)
                            // into the session total. Done here, not
                            // inline with each chunk, so a build that
                            // emits intermediate running totals
                            // contributes its FINAL value once instead
                            // of being summed multiple times.
                            if let Some(n) = turn_eval {
                                *reported_tokens =
                                    Some(reported_tokens.unwrap_or(0).saturating_add(n));
                            }
                            if let Some(d) = turn_eval_duration {
                                *reported_eval_ns =
                                    Some(reported_eval_ns.unwrap_or(0).saturating_add(d));
                            }
                            return Ok(Some(decide_outcome(pending_tool_calls)));
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
                        // EOF without an explicit `done: true` — treat as a
                        // natural terminator and let the caller emit Done.
                        // Still fold any partial turn_eval / eval_duration.
                        if let Some(n) = turn_eval {
                            *reported_tokens =
                                Some(reported_tokens.unwrap_or(0).saturating_add(n));
                        }
                        if let Some(d) = turn_eval_duration {
                            *reported_eval_ns =
                                Some(reported_eval_ns.unwrap_or(0).saturating_add(d));
                        }
                        return Ok(Some(decide_outcome(pending_tool_calls)));
                    }
                }
            }
        }
    }
}

fn decide_outcome(calls: Vec<OllamaToolCall>) -> TurnOutcome {
    if calls.is_empty() {
        TurnOutcome::Done
    } else {
        TurnOutcome::Tools(calls)
    }
}

fn emit_metrics(
    app: &AppHandle,
    channel: &str,
    tokens: u32,
    eval_ns: Option<u64>,
    start: Instant,
) {
    let elapsed = start.elapsed().as_millis() as u64;
    // Prefer Ollama's own `eval_duration` (pure decode time) so the rate
    // reflects generation speed, not the wall clock — which also folds in model
    // load, prompt evaluation, and any tool round-trips, understating tok/s
    // (badly so after a cold load). Fall back to wall-clock when the server
    // didn't report it (older builds) or nothing was generated. `elapsed_ms`
    // stays the full turn wall-clock — still useful, and unchanged on the wire.
    let tps = match eval_ns {
        Some(ns) if ns > 0 && tokens > 0 => {
            (tokens as f64) * 1_000_000_000.0 / (ns as f64)
        }
        _ if elapsed > 0 => (tokens as f64) * 1000.0 / (elapsed as f64),
        _ => 0.0,
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

/// App-default context window, mirrored from `DEFAULT_PARAMS.num_ctx` in
/// `src/types.ts`. The startup preload (in `preload.rs`) can't resolve a
/// model's Modelfile defaults the way the frontend does, so it warms with this
/// value — the size the first real message most commonly asks for. The
/// post-unlock JS preload re-fires with the precisely-resolved params, so any
/// mismatch here is corrected before the user's first send. Keep in sync with
/// the TS default.
pub const DEFAULT_NUM_CTX: u32 = 8192;

/// Build the Ollama `options` object for a preload so the warmed runner is
/// sized like the one the first real chat request will ask for. `num_ctx` is
/// the load-bearing one (a mismatch forces a KV-cache realloc, i.e. a reload);
/// `low_vram` / `num_gpu` matter on memory-constrained setups. Returns `None`
/// when nothing is set so the request body omits `options` entirely.
pub fn preload_options(
    num_ctx: Option<u32>,
    low_vram: Option<bool>,
    num_gpu: Option<u32>,
) -> Option<Value> {
    let mut o = serde_json::Map::new();
    if let Some(v) = num_ctx {
        o.insert("num_ctx".into(), json!(v));
    }
    if let Some(v) = low_vram {
        o.insert("low_vram".into(), json!(v));
    }
    if let Some(v) = num_gpu {
        o.insert("num_gpu".into(), json!(v));
    }
    if o.is_empty() {
        None
    } else {
        Some(Value::Object(o))
    }
}

/// Translate the stored `ollama_keep_alive` setting string into the JSON
/// value Ollama's `keep_alive` field expects. Ollama accepts either a Go
/// duration string ("5m", "30m", "1h") or an integer number of seconds,
/// where a negative value means "keep the model resident until it is
/// explicitly unloaded". We send the until-unloaded sentinel as a JSON
/// number (`-1`) rather than the string `"-1"` because Go's
/// `time.ParseDuration` rejects a unit-less string. An empty / unset value
/// yields `None`, letting Ollama apply its built-in 5-minute idle default —
/// exactly the behaviour Loach had before this setting existed.
pub fn keep_alive_value(setting: &str) -> Option<Value> {
    let s = setting.trim();
    if s.is_empty() {
        return None;
    }
    match s.parse::<i64>() {
        Ok(n) => Some(json!(n)),
        Err(_) => Some(json!(s)),
    }
}

fn build_options(req: &ChatRequest) -> Value {
    let mut o = serde_json::Map::new();
    let p = &req.params;
    if let Some(v) = p.temperature {
        o.insert("temperature".into(), json!(v));
    }
    if let Some(v) = p.top_p {
        o.insert("top_p".into(), json!(v));
    }
    if let Some(v) = p.top_k {
        o.insert("top_k".into(), json!(v));
    }
    if let Some(v) = p.min_p {
        o.insert("min_p".into(), json!(v));
    }
    if let Some(v) = p.max_tokens {
        o.insert("num_predict".into(), json!(v));
    }
    if let Some(v) = p.num_ctx {
        o.insert("num_ctx".into(), json!(v));
    }
    if let Some(v) = p.repeat_penalty {
        o.insert("repeat_penalty".into(), json!(v));
    }
    if let Some(v) = p.frequency_penalty {
        o.insert("frequency_penalty".into(), json!(v));
    }
    if let Some(v) = p.presence_penalty {
        o.insert("presence_penalty".into(), json!(v));
    }
    if let Some(v) = p.seed {
        o.insert("seed".into(), json!(v));
    }
    if let Some(v) = p.num_gpu {
        o.insert("num_gpu".into(), json!(v));
    }
    if let Some(v) = p.low_vram {
        o.insert("low_vram".into(), json!(v));
    }
    Value::Object(o)
}

fn ollama_tool_def(def: &McpToolDef) -> Value {
    // Ollama follows the OpenAI tools schema:
    //   {"type":"function","function":{"name","description","parameters"}}
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

fn serialise_tool_call(call: &OllamaToolCall) -> Value {
    let name = call
        .function
        .as_ref()
        .map(|f| f.name.clone())
        .unwrap_or_default();
    let args = call
        .function
        .as_ref()
        .map(|f| normalise_args(&f.arguments))
        .unwrap_or_else(|| json!({}));
    json!({
        "function": { "name": name, "arguments": args }
    })
}

/// Some Ollama builds (and the OpenAI compat passes) hand `arguments` as a
/// stringified JSON instead of a parsed object. Normalise both shapes to a
/// JSON value so the dispatcher always gets the same input.
///
/// When a string can't be parsed back as JSON (malformed model output, an
/// edge-case escape, etc.) we forward it as a raw `Value::String` so the
/// tool call still happens — the tool sees a malformed input and replies
/// with an error the model can react to. We log the parse failure at
/// `warn` so users debugging "why does this tool always fail" don't have
/// to guess; the silent fallback would otherwise hide the cause.
fn normalise_args(v: &Value) -> Value {
    match v {
        Value::String(s) => match serde_json::from_str(s) {
            Ok(parsed) => parsed,
            Err(e) => {
                tracing::warn!(
                    "ollama tool call: arguments are not valid JSON ({e}); forwarding raw text"
                );
                Value::String(s.clone())
            }
        },
        Value::Null => json!({}),
        other => other.clone(),
    }
}

fn resolve_qualified<'a>(
    tools: &'a [McpToolDef],
    qualified: &str,
) -> Option<(&'a McpToolDef, String)> {
    let def = tools.iter().find(|t| t.qualified_name == qualified)?;
    Some((def, def.name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- normalise_args -------------------------------------------------------
    // Ollama mainline hands `arguments` as a parsed object, but some builds
    // and the OpenAI-compat passes hand a stringified JSON. The dispatcher
    // must see one shape regardless of which fork the user runs.

    #[test]
    fn normalise_args_passes_objects_through() {
        let v = json!({"city": "Oslo"});
        assert_eq!(normalise_args(&v), v);
    }

    #[test]
    fn normalise_args_parses_stringified_json() {
        let v = Value::String(r#"{"city":"Oslo","n":2}"#.into());
        assert_eq!(normalise_args(&v), json!({"city": "Oslo", "n": 2}));
    }

    #[test]
    fn normalise_args_forwards_unparseable_strings_raw() {
        // Malformed model output still reaches the tool (which replies with
        // an error the model can react to) instead of killing the call.
        let v = Value::String("{city: Oslo}".into());
        assert_eq!(normalise_args(&v), v);
    }

    #[test]
    fn normalise_args_maps_null_to_empty_object() {
        assert_eq!(normalise_args(&Value::Null), json!({}));
    }

    // --- serialise_tool_call ----------------------------------------------------

    #[test]
    fn serialise_tool_call_round_trips_into_history_shape() {
        // The echo of the model's own call that we put back into the
        // transcript must carry normalised arguments — feeding the
        // stringified variant back verbatim confuses follow-up turns.
        let call = OllamaToolCall {
            function: Some(OllamaToolFn {
                name: "get_weather".into(),
                arguments: Value::String(r#"{"city":"Oslo"}"#.into()),
            }),
        };
        assert_eq!(
            serialise_tool_call(&call),
            json!({ "function": { "name": "get_weather", "arguments": { "city": "Oslo" } } })
        );
    }

    #[test]
    fn serialise_tool_call_tolerates_missing_function() {
        // A `tool_calls` entry with no `function` body (seen from forks
        // mid-stream) serialises to an empty shell rather than panicking.
        let call = OllamaToolCall { function: None };
        assert_eq!(
            serialise_tool_call(&call),
            json!({ "function": { "name": "", "arguments": {} } })
        );
    }
}

