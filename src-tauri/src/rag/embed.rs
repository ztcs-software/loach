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

#[derive(Debug, Clone)]
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
pub async fn embed_query(http: &reqwest::Client, cfg: &EmbedConfig, query: &str) -> Result<Vec<f32>, String> {
    let input = (prefixes(&cfg.model).1)(query);
    let mut out = embed(http, cfg, &[input], QUERY_TIMEOUT).await?;
    out.pop().ok_or_else(|| "the embedding model returned nothing".to_string())
}

/// Embed a batch of inputs, unit-length, in input order.
pub async fn embed_batch(http: &reqwest::Client, cfg: &EmbedConfig, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
    embed(http, cfg, inputs, EMBED_TIMEOUT).await
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
) -> Result<Vec<Vec<f32>>, String> {
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
        ));
    }
    Ok(vectors.into_iter().map(super::normalize).collect())
}

/// A short, readable reason from an error response (`{"error": "..."}` from
/// Ollama, `{"error": {"message": ...}}` from OpenAI-style servers).
async fn error_body(status: reqwest::StatusCode, resp: reqwest::Response) -> String {
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
    format!("HTTP {}: {}", status.as_u16(), reason.trim())
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
        assert_eq!(document_input(&cfg("bge-m3"), "T", "x"), "T\n\nx");
        assert_eq!(cfg("bge-m3").model_key(), "ollama:bge-m3");
    }
}
