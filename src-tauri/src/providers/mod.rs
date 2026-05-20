pub mod ollama;
pub mod openai;

use serde::{Deserialize, Serialize};

use crate::mcp::McpToolDef;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub provider: String,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GenerationParams {
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub min_p: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub num_ctx: Option<u32>,
    #[serde(default)]
    pub repeat_penalty: Option<f32>,
    #[serde(default)]
    pub frequency_penalty: Option<f32>,
    #[serde(default)]
    pub presence_penalty: Option<f32>,
    #[serde(default)]
    pub seed: Option<i64>,
    /// Reasoning toggle for thinking-capable models (Qwen3, DeepSeek-R1,
    /// GPT-OSS, …). `Some(true)` forces a chain-of-thought before the
    /// reply; `Some(false)` suppresses it; `None` lets Ollama use the
    /// model's own default. Models without thinking capability ignore the
    /// flag — Ollama returns an error for them, but the frontend gates the
    /// toggle on the model's `capabilities` so we never send it for those.
    #[serde(default)]
    pub think: Option<bool>,
    /// Number of model layers to offload to the GPU (Ollama `num_gpu`).
    /// `Some(0)` forces CPU-only inference, `Some(n)` offloads `n` layers,
    /// `None` lets Ollama auto-detect based on available VRAM. Useful for
    /// users whose model OOMs the GPU and need to dial offload down.
    #[serde(default)]
    pub num_gpu: Option<u32>,
    /// Enable Ollama's low-VRAM mode. `Some(true)` opts in (smaller batches,
    /// reduced KV cache); `None` / `Some(false)` follows Ollama's default
    /// (off). Pairs with `num_gpu` for memory-constrained setups.
    #[serde(default)]
    pub low_vram: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessageIn {
    pub role: String, // user | assistant | system
    pub content: String,
    /// Base64 image data (no data-URI prefix) for multimodal models.
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatRequest {
    pub stream_id: String,
    pub provider: String, // "ollama" | "openai"
    pub model: String,
    pub base_url: String,
    pub system_prompt: Option<String>,
    pub messages: Vec<ChatMessageIn>,
    pub params: GenerationParams,
    /// MCP tools exposed to the model for this turn. Populated server-side
    /// by [`crate::commands::chat_stream`] from the enabled MCP servers;
    /// the frontend never has to construct this list. Empty when no MCP
    /// servers are configured or none are reachable.
    #[serde(default, skip_deserializing)]
    pub tools: Vec<McpToolDef>,
}
