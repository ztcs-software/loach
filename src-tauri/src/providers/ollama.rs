use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::select;

use super::{ChatRequest, ModelInfo};
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
) -> Result<()> {
    let cancel = registry.register(stream_id.clone());
    let channel = admin_channel(&stream_id);

    let resp = match http.post(&url).json(&body).send().await {
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
                let _ = app.emit(&channel, AdminEvent::Done);
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
) -> Result<()> {
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "name": name, "stream": true });
    drive_progress_stream(app, registry, stream_id, url, body, http).await
}

pub async fn create_model(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    base_url: &str,
    name: &str,
    modelfile: &str,
    stream_id: String,
) -> Result<()> {
    let url = format!("{}/api/create", base_url.trim_end_matches('/'));
    // Ollama 0.3+ supports `modelfile` as a field on `/api/create` so we
    // don't need to write a temp file. `stream: true` keeps the NDJSON
    // progress frames flowing.
    let body = serde_json::json!({
        "name": name,
        "modelfile": modelfile,
        "stream": true,
    });
    drive_progress_stream(app, registry, stream_id, url, body, http).await
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
    http.get(format!("{}/api/tags", base_url.trim_end_matches('/')))
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub async fn list_models(http: &Client, base_url: &str) -> Result<Vec<ModelInfo>> {
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
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [],
        "stream": false,
        "keep_alive": 0,
    });
    let _ = http.post(url).json(&body).timeout(ADMIN_TIMEOUT).send().await;
    Ok(())
}

/// Preload a model into VRAM by sending an empty chat. The default Ollama
/// keep_alive (5m) takes over after the load completes, so the model stays
/// resident long enough for the user's first real request to skip the cold
/// load. Errors are swallowed — preload is best-effort and must never block
/// app startup if Ollama is unreachable or the model is missing.
pub async fn preload_model(http: &Client, base_url: &str, model: &str) -> Result<()> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [],
        "stream": false,
    });
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

#[derive(Debug, Serialize)]
struct OllamaChatMessage<'a> {
    role: &'a str,
    content: &'a str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_k: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_ctx: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repeat_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_gpu: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    low_vram: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct OllamaChunk {
    #[serde(default)]
    message: Option<OllamaChunkMsg>,
    #[serde(default)]
    done: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaChunkMsg {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
}

pub async fn chat_stream(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    req: ChatRequest,
) -> Result<()> {
    let cancel = registry.register(req.stream_id.clone());
    let channel = event_channel(&req.stream_id);

    let mut messages: Vec<OllamaChatMessage> = Vec::new();
    if let Some(sys) = req.system_prompt.as_deref() {
        if !sys.is_empty() {
            messages.push(OllamaChatMessage {
                role: "system",
                content: sys,
                images: vec![],
            });
        }
    }
    for m in &req.messages {
        messages.push(OllamaChatMessage {
            role: &m.role,
            content: &m.content,
            images: m.images.clone(),
        });
    }

    // Build the body as a mut Map so we can conditionally include `think`
    // only when the user (or model default) has explicitly set it. Sending
    // `think: null` to Ollama is fine but verbose; omitting the field
    // entirely is the cleanest way to express "use the model default".
    let mut body = serde_json::json!({
        "model": req.model,
        "messages": messages,
        "stream": true,
        "options": OllamaOptions {
            temperature: req.params.temperature,
            top_p: req.params.top_p,
            top_k: req.params.top_k,
            min_p: req.params.min_p,
            num_predict: req.params.max_tokens,
            num_ctx: req.params.num_ctx,
            repeat_penalty: req.params.repeat_penalty,
            frequency_penalty: req.params.frequency_penalty,
            presence_penalty: req.params.presence_penalty,
            seed: req.params.seed,
            num_gpu: req.params.num_gpu,
            low_vram: req.params.low_vram,
        }
    });
    if let Some(think) = req.params.think {
        body["think"] = serde_json::Value::Bool(think);
    }

    let url = format!("{}/api/chat", req.base_url.trim_end_matches('/'));
    let mut resp = match http.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                &channel,
                StreamEvent::Error {
                    message: format!("Ollama request failed: {e}"),
                },
            );
            registry.finish(&req.stream_id);
            return Err(e.into());
        }
    };

    // Safety net: older Ollama builds don't advertise the "thinking"
    // capability in /api/show, so we can't always know up front whether the
    // model supports it. If the server rejects the request specifically
    // because the model doesn't support thinking, drop the flag and retry
    // once before giving up.
    if !resp.status().is_success() && body.get("think").is_some() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if text.contains("does not support thinking") {
            if let Some(obj) = body.as_object_mut() {
                obj.remove("think");
            }
            resp = match http.post(&url).json(&body).send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = app.emit(
                        &channel,
                        StreamEvent::Error {
                            message: format!("Ollama request failed: {e}"),
                        },
                    );
                    registry.finish(&req.stream_id);
                    return Err(e.into());
                }
            };
        } else {
            let _ = app.emit(
                &channel,
                StreamEvent::Error {
                    message: format!("Ollama HTTP {status}: {text}"),
                },
            );
            registry.finish(&req.stream_id);
            return Err(anyhow!("ollama http error"));
        }
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            &channel,
            StreamEvent::Error {
                message: format!("Ollama HTTP {status}: {text}"),
            },
        );
        registry.finish(&req.stream_id);
        return Err(anyhow!("ollama http error"));
    }

    let start = Instant::now();
    let mut token_count: u32 = 0;
    let mut byte_stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    loop {
        select! {
            biased;
            _ = cancel.notified() => {
                // Drop the byte stream before returning so reqwest closes
                // the TCP connection right away — same rationale as in
                // `drive_progress_stream`. Without this the connection
                // close waits for the calling task to unwind, which can
                // leave the server processing the request for noticeably
                // longer than needed.
                drop(byte_stream);
                let _ = app.emit(&channel, StreamEvent::Done);
                registry.finish(&req.stream_id);
                return Ok(());
            }
            maybe = byte_stream.next() => {
                match maybe {
                    Some(Ok(chunk)) => {
                        buf.extend_from_slice(&chunk);
                        // Per-frame ceiling — see the matching guard in
                        // `drive_progress_stream`. A stream that never
                        // delivers a newline shouldn't be allowed to balloon.
                        if buf.len() > MAX_LINE_BYTES && !buf.contains(&b'\n') {
                            let _ = app.emit(
                                &channel,
                                StreamEvent::Error {
                                    message: format!(
                                        "stream exceeded {} bytes without a frame delimiter — aborting",
                                        MAX_LINE_BYTES
                                    ),
                                },
                            );
                            registry.finish(&req.stream_id);
                            return Err(anyhow!("ollama chat stream frame too large"));
                        }
                        // Coalesce every delta in this network chunk into one
                        // Token / Thinking event before emitting. Ollama
                        // frequently hands us several NDJSON lines per read;
                        // batching collapses N emits + N React state updates
                        // into one, with no visible difference (the deltas
                        // would have been concatenated in the bubble anyway).
                        let mut pending_token = String::new();
                        let mut pending_think = String::new();
                        let mut finished = false;
                        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let line = &line[..line.len() - 1];
                            if line.is_empty() { continue; }
                            match serde_json::from_slice::<OllamaChunk>(line) {
                                Ok(parsed) => {
                                    if let Some(msg) = parsed.message {
                                        if let Some(think) = msg.thinking {
                                            if !think.is_empty() {
                                                pending_think.push_str(&think);
                                            }
                                        }
                                        if let Some(delta) = msg.content {
                                            if !delta.is_empty() {
                                                token_count += 1;
                                                pending_token.push_str(&delta);
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
                                &channel,
                                StreamEvent::Thinking { delta: pending_think },
                            );
                        }
                        if !pending_token.is_empty() {
                            let _ = app.emit(
                                &channel,
                                StreamEvent::Token { delta: pending_token },
                            );
                        }
                        if finished {
                            let elapsed = start.elapsed().as_millis() as u64;
                            let tps = if elapsed > 0 {
                                (token_count as f64) * 1000.0 / (elapsed as f64)
                            } else { 0.0 };
                            let _ = app.emit(
                                &channel,
                                StreamEvent::Metrics {
                                    tokens: token_count,
                                    elapsed_ms: elapsed,
                                    tokens_per_second: tps,
                                },
                            );
                            let _ = app.emit(&channel, StreamEvent::Done);
                            registry.finish(&req.stream_id);
                            return Ok(());
                        }
                    }
                    Some(Err(e)) => {
                        let _ = app.emit(
                            &channel,
                            StreamEvent::Error { message: format!("stream error: {e}") },
                        );
                        registry.finish(&req.stream_id);
                        return Err(e.into());
                    }
                    None => {
                        let elapsed = start.elapsed().as_millis() as u64;
                        let tps = if elapsed > 0 {
                            (token_count as f64) * 1000.0 / (elapsed as f64)
                        } else { 0.0 };
                        let _ = app.emit(
                            &channel,
                            StreamEvent::Metrics {
                                tokens: token_count,
                                elapsed_ms: elapsed,
                                tokens_per_second: tps,
                            },
                        );
                        let _ = app.emit(&channel, StreamEvent::Done);
                        registry.finish(&req.stream_id);
                        return Ok(());
                    }
                }
            }
        }
    }
}
