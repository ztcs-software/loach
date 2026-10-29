//! Embedding calls for the retrieval index: Ollama's `/api/embed` or an
//! OpenAI-compatible `/embeddings`, chosen in Settings → Library.
//!
//! Both go through the shared provider client with the same guards the chat
//! path uses: link-local hosts are refused, and the OpenAI key only travels
//! over https or to loopback.

use std::time::Duration;

use serde::Deserialize;

use crate::db::Database;

/// Mirrors the frontend defaults in `src/types.ts`.
const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// Long enough for Ollama to load the model on the first batch.
const EMBED_TIMEOUT: Duration = Duration::from_secs(120);
/// A query embedding sits on the send path, so it gets less patience.
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);

/// Why an embedding request failed.
#[derive(Debug)]
pub struct EmbedError {
    pub message: String,
    /// The server answered and turned the input down (too long, malformed),
    /// as opposed to being unreachable, rate-limiting, overloaded or missing
    /// the model — failures that say nothing about the input itself.
    pub refused: bool,
}

impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Transport, decoding and setup failures: never about the input.
impl From<String> for EmbedError {
    fn from(message: String) -> Self {
        Self { message, refused: false }
    }
}

/// Whether an error response means "this input can't be embedded" rather
/// than "the server can't embed right now". 400 / 413 / 422 are the
/// input-is-wrong statuses; llama.cpp-based servers answer an input over
/// their batch size with a 500 that says so, hence the wording check.
pub fn is_refusal(status: u16, message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    matches!(status, 400 | 413 | 422)
        || (status >= 500 && (m.contains("too large") || m.contains("too long")))
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbedConfig {
    /// `"ollama"` or `"openai"`.
    pub provider: String,
    pub model: String,
    pub base_url: String,
}

impl EmbedConfig {
    /// The configured embedding model, or `None` when none is set — the
    /// index then stays keyword-only.
    pub fn from_db(db: &Database) -> Option<Self> {
        let get = |k: &str| db.get_setting(k).ok().flatten().unwrap_or_default();
        let model = get("embedding_model").trim().to_string();
        if model.is_empty() {
            return None;
        }
        let provider = match get("embedding_provider").as_str() {
            "openai" => "openai",
            _ => "ollama",
        };
        let base_url = if provider == "openai" {
            Some(get("openai_base_url")).filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string())
        } else {
            Some(get("ollama_base_url")).filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string())
        };
        Some(Self { provider: provider.to_string(), model, base_url })
    }

    /// What `rag_chunks.embed_model` records, so switching provider or model
    /// marks every existing vector stale.
    pub fn model_key(&self) -> String {
        format!("{}:{}", self.provider, self.model)
    }
}

/// Formats a chunk (given its document title) for embedding.
type DocFormat = fn(&str, &str) -> String;
/// Formats a search query for embedding.
type QueryFormat = fn(&str) -> String;

/// Several embedding models are trained with task prefixes and retrieve
/// noticeably worse without them. Returns `(document, query)` formatters.
fn prefixes(model: &str) -> (DocFormat, QueryFormat) {
    let m = model.to_ascii_lowercase();
    if m.contains("nomic-embed") {
        (|t, x| format!("search_document: {t}\n\n{x}"), |q| format!("search_query: {q}"))
    } else if m.contains("embeddinggemma") {
        (
            |t, x| format!("title: {} | text: {x}", if t.is_empty() { "none" } else { t }),
            |q| format!("task: search result | query: {q}"),
        )
    } else if m.contains("mxbai-embed") {
        (
            |t, x| format!("{t}\n\n{x}"),
            |q| format!("Represent this sentence for searching relevant passages: {q}"),
        )
    } else if m.contains("qwen3-embedding") {
        (
            |t, x| format!("{t}\n\n{x}"),
            |q| format!("Instruct: Given a question, retrieve passages that answer it\nQuery: {q}"),
        )
    } else {
        (|t, x| format!("{t}\n\n{x}"), |q| q.to_string())
    }
}

/// Text the indexer embeds for one chunk of the document titled `title`.
pub fn document_input(cfg: &EmbedConfig, title: &str, text: &str) -> String {
    (prefixes(&cfg.model).0)(title, text)
}

/// Embed one search query, unit-length.
pub async fn embed_query(http: &reqwest::Client, cfg: &EmbedConfig, query: &str) -> Result<Vec<f32>, EmbedError> {
    let input = (prefixes(&cfg.model).1)(query);
    let mut out = embed(http, cfg, &[input], QUERY_TIMEOUT).await?;
    out.pop().ok_or_else(|| "the embedding model returned nothing".to_string().into())
}

/// Embed a batch of inputs, unit-length, in input order.
pub async fn embed_batch(http: &reqwest::Client, cfg: &EmbedConfig, inputs: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
    embed(http, cfg, inputs, EMBED_TIMEOUT).await
}

/// Embed one trivial input: whether the model embeds anything at all, when
/// an input failed on its own or every real input was refused. Background
/// work, so the indexer's patience: after a runner crashed on an input,
/// Ollama reloads the model before answering.
pub async fn probe(http: &reqwest::Client, cfg: &EmbedConfig) -> Result<(), EmbedError> {
    embed(http, cfg, &["hello".to_string()], EMBED_TIMEOUT).await.map(|_| ())
}

#[derive(Deserialize)]
struct OllamaEmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Deserialize)]
struct OpenAIEmbedResponse {
    data: Vec<OpenAIEmbedding>,
}

#[derive(Deserialize)]
struct OpenAIEmbedding {
    index: usize,
    embedding: Vec<f32>,
}

async fn embed(
    http: &reqwest::Client,
    cfg: &EmbedConfig,
    inputs: &[String],
    timeout: Duration,
) -> Result<Vec<Vec<f32>>, EmbedError> {
    crate::providers::refuse_link_local_host(&cfg.base_url).await?;
    let base = cfg.base_url.trim_end_matches('/');
    let vectors = if cfg.provider == "openai" {
        let mut req = http
            .post(format!("{base}/embeddings"))
            .timeout(timeout)
            .json(&serde_json::json!({ "model": cfg.model, "input": inputs }));
        // Off the runtime — blocking OS-keyring read, as in the chat path.
        let key = tokio::task::spawn_blocking(crate::secrets::get_openai_key)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        if let Some(key) = key.filter(|k| !k.is_empty()) {
            if crate::providers::openai::is_safe_for_bearer(&cfg.base_url) {
                req = req.bearer_auth(key);
            }
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            return Err(error_body(status, resp).await);
        }
        let mut body: OpenAIEmbedResponse = resp.json().await.map_err(|e| e.to_string())?;
        body.data.sort_by_key(|d| d.index);
        body.data.into_iter().map(|d| d.embedding).collect::<Vec<_>>()
    } else {
        let resp = http
            .post(format!("{base}/api/embed"))
            .timeout(timeout)
            .json(&serde_json::json!({ "model": cfg.model, "input": inputs, "truncate": true }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            return Err(error_body(status, resp).await);
        }
        let body: OllamaEmbedResponse = resp.json().await.map_err(|e| e.to_string())?;
        body.embeddings
    };
    if vectors.len() != inputs.len() {
        return Err(format!(
            "the embedding model returned {} vectors for {} inputs",
            vectors.len(),
            inputs.len()
        )
        .into());
    }
    Ok(vectors.into_iter().map(super::normalize).collect())
}

/// A short, readable reason from an error response (`{"error": "..."}` from
/// Ollama, `{"error": {"message": ...}}` from OpenAI-style servers).
async fn error_body(status: reqwest::StatusCode, resp: reqwest::Response) -> EmbedError {
    let text = resp.text().await.unwrap_or_default();
    let reason = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            let e = v.get("error")?;
            e.as_str()
                .map(str::to_string)
                .or_else(|| e.get("message").and_then(|m| m.as_str()).map(str::to_string))
        })
        .unwrap_or_else(|| text.chars().take(200).collect());
    let reason = reason.trim();
    EmbedError {
        message: format!("HTTP {}: {}", status.as_u16(), reason),
        refused: is_refusal(status.as_u16(), reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(model: &str) -> EmbedConfig {
        EmbedConfig { provider: "ollama".into(), model: model.into(), base_url: String::new() }
    }

    #[test]
    fn task_prefixes_follow_the_model() {
        assert_eq!(document_input(&cfg("nomic-embed-text:latest"), "T", "x"), "search_document: T\n\nx");
        assert_eq!(document_input(&cfg("embeddinggemma"), "", "x"), "title: none | text: x");
        // EmbeddingGemma 2 kept the first one's prompts.
        assert_eq!(document_input(&cfg("embeddinggemma-2:270m"), "", "x"), "title: none | text: x");
        assert_eq!(document_input(&cfg("bge-m3"), "T", "x"), "T\n\nx");
        assert_eq!(cfg("bge-m3").model_key(), "ollama:bge-m3");
    }

    #[test]
    fn only_input_errors_count_as_refusals() {
        // The input itself is the problem: worth isolating and setting aside.
        assert!(is_refusal(400, "input length exceeds the context length"));
        assert!(is_refusal(413, "Input validation error: inputs must have less than 512 tokens"));
        assert!(is_refusal(422, "invalid input"));
        assert!(is_refusal(500, "input is too large to process. increase the physical batch size"));
        // The server or model is: retry later, set nothing aside.
        assert!(!is_refusal(404, "model 'nomic-embed-text' not found"));
        assert!(!is_refusal(401, "invalid api key"));
        assert!(!is_refusal(429, "rate limit reached"));
        assert!(!is_refusal(500, "llama runner process has terminated"));
        assert!(!is_refusal(503, "server overloaded"));
    }
}
