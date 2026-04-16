use std::time::Instant;

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::select;

use super::{ChatRequest, ModelInfo};
use crate::secrets;
use crate::stream::{event_channel, StreamEvent, StreamRegistry};

pub fn default_base_url() -> &'static str {
    "https://api.openai.com/v1"
}

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
    let mut req = http.get(url);
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
}

#[derive(Debug, Deserialize)]
struct SseChunk {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Debug, Serialize)]
struct OaMsg {
    role: &'static str,
    content: Value,
}

fn build_messages(req: &ChatRequest) -> Vec<OaMsg> {
    let mut out: Vec<OaMsg> = Vec::new();
    if let Some(sys) = req.system_prompt.as_deref() {
        if !sys.is_empty() {
            out.push(OaMsg {
                role: "system",
                content: Value::String(sys.to_string()),
            });
        }
    }
    for m in &req.messages {
        let role: &'static str = match m.role.as_str() {
            "assistant" => "assistant",
            "system" => "system",
            _ => "user",
        };
        let content = if m.images.is_empty() {
            Value::String(m.content.clone())
        } else {
            let mut parts: Vec<Value> = Vec::new();
            if !m.content.is_empty() {
                parts.push(json!({ "type": "text", "text": m.content }));
            }
            for img in &m.images {
                // Assume PNG unless caller provides otherwise; GPT-4o accepts either.
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:image/png;base64,{img}") }
                }));
            }
            Value::Array(parts)
        };
        out.push(OaMsg { role, content });
    }
    out
}

pub async fn chat_stream(
    app: AppHandle,
    http: Client,
    registry: StreamRegistry,
    req: ChatRequest,
) -> Result<()> {
    let cancel = registry.register(req.stream_id.clone());
    let channel = event_channel(&req.stream_id);

    let messages = build_messages(&req);

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

    let url = format!("{}/chat/completions", req.base_url.trim_end_matches('/'));
    let mut http_req = http.post(url).json(&body);
    if let Some(key) = secrets::get_openai_key().ok().flatten() {
        if !key.is_empty() {
            http_req = http_req.bearer_auth(key);
        }
    }

    let resp = match http_req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                &channel,
                StreamEvent::Error {
                    message: format!("OpenAI request failed: {e}"),
                },
            );
            registry.finish(&req.stream_id);
            return Err(e.into());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            &channel,
            StreamEvent::Error {
                message: format!("OpenAI HTTP {status}: {text}"),
            },
        );
        registry.finish(&req.stream_id);
        return Err(anyhow!("openai http error"));
    }

    let start = Instant::now();
    let mut token_count: u32 = 0;
    let mut byte_stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    loop {
        select! {
            biased;
            _ = cancel.notified() => {
                let _ = app.emit(&channel, StreamEvent::Done);
                registry.finish(&req.stream_id);
                return Ok(());
            }
            maybe = byte_stream.next() => {
                match maybe {
                    Some(Ok(chunk)) => {
                        buf.extend_from_slice(&chunk);
                        // SSE frames are separated by double newlines.
                        while let Some(pos) = find_double_newline(&buf) {
                            let frame: Vec<u8> = buf.drain(..pos + 2).collect();
                            // Strip trailing \n\n
                            let text = String::from_utf8_lossy(&frame[..frame.len() - 2]).to_string();
                            for line in text.lines() {
                                let line = line.trim_start();
                                if !line.starts_with("data:") { continue; }
                                let data = line[5..].trim_start();
                                if data == "[DONE]" {
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
                                if let Ok(parsed) = serde_json::from_str::<SseChunk>(data) {
                                    for c in parsed.choices {
                                        if let Some(d) = c.delta {
                                            if let Some(ref think) = d.reasoning_content {
                                                if !think.is_empty() {
                                                    let _ = app.emit(
                                                        &channel,
                                                        StreamEvent::Thinking { delta: think.clone() },
                                                    );
                                                }
                                            }
                                            if let Some(delta) = d.content {
                                                if !delta.is_empty() {
                                                    token_count += 1;
                                                    let _ = app.emit(
                                                        &channel,
                                                        StreamEvent::Token { delta },
                                                    );
                                                }
                                            }
                                        }
                                        if c.finish_reason.is_some() {
                                            // Wait for [DONE] marker; some proxies omit it, so also close on finish.
                                        }
                                    }
                                }
                            }
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

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}
