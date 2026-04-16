use std::time::Instant;

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::select;

use super::{ChatRequest, ModelInfo};
use crate::stream::{event_channel, StreamEvent, StreamRegistry};

pub fn default_base_url() -> &'static str {
    "http://localhost:11434"
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
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub async fn list_models(http: &Client, base_url: &str) -> Result<Vec<ModelInfo>> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = http.get(url).send().await?.error_for_status()?;
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
    let _ = http.post(url).json(&body).send().await;
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

    let body = serde_json::json!({
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
        }
    });

    let url = format!("{}/api/chat", req.base_url.trim_end_matches('/'));
    let resp = match http.post(url).json(&body).send().await {
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
                let _ = app.emit(&channel, StreamEvent::Done);
                registry.finish(&req.stream_id);
                return Ok(());
            }
            maybe = byte_stream.next() => {
                match maybe {
                    Some(Ok(chunk)) => {
                        buf.extend_from_slice(&chunk);
                        // NDJSON: split on newlines
                        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let line = &line[..line.len() - 1];
                            if line.is_empty() { continue; }
                            match serde_json::from_slice::<OllamaChunk>(line) {
                                Ok(parsed) => {
                                    if let Some(msg) = parsed.message {
                                        if let Some(ref think) = msg.thinking {
                                            if !think.is_empty() {
                                                let _ = app.emit(
                                                    &channel,
                                                    StreamEvent::Thinking { delta: think.clone() },
                                                );
                                            }
                                        }
                                        if let Some(delta) = msg.content {
                                            if !delta.is_empty() {
                                                token_count += 1;
                                                let _ = app.emit(
                                                    &channel,
                                                    StreamEvent::Token { delta },
                                                );
                                            }
                                        }
                                    }
                                    if parsed.done {
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
                                Err(e) => {
                                    tracing::warn!("ollama parse error: {e}");
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
