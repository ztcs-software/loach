pub mod ollama;
pub mod openai;

use serde::{Deserialize, Serialize};

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
}
