use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::Notify;

/// Tracks in-flight streaming generations so we can cancel them from the frontend.
#[derive(Clone)]
pub struct StreamRegistry {
    inner: Arc<DashMap<String, Arc<Notify>>>,
}

impl StreamRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
        }
    }

    pub fn register(&self, id: String) -> Arc<Notify> {
        let n = Arc::new(Notify::new());
        self.inner.insert(id, n.clone());
        n
    }

    pub fn cancel(&self, id: &str) {
        if let Some((_, n)) = self.inner.remove(id) {
            n.notify_waiters();
        }
    }

    pub fn finish(&self, id: &str) {
        self.inner.remove(id);
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    Token { delta: String },
    Thinking { delta: String },
    Done,
    Error { message: String },
    Metrics {
        tokens: u32,
        elapsed_ms: u64,
        tokens_per_second: f64,
    },
}

pub fn event_channel(stream_id: &str) -> String {
    format!("chat://{stream_id}")
}

/// Event channel used by long-running model-admin operations (pull / create).
/// Kept separate from the chat channel so the UI can listen for progress
/// updates without colliding with a concurrent chat stream that happens to
/// share the same id space.
pub fn admin_channel(stream_id: &str) -> String {
    format!("admin://{stream_id}")
}

/// Progress frame for model-admin streams. Emitted by Ollama pull / create
/// endpoints. Fields mirror Ollama's NDJSON keys (`status`, `digest`,
/// `total`, `completed`). Any of them may be absent depending on which
/// phase the daemon is reporting.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AdminEvent {
    Progress {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        digest: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        completed: Option<u64>,
    },
    Done,
    Error {
        message: String,
    },
}
