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
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub frequency_penalty: Option<f32>,
    #[serde(default)]
    pub presence_penalty: Option<f32>,
    #[serde(default)]
    pub num_ctx: Option<u32>,
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
