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

    /// Insert a Notify for `id` and return a handle. If `id` is already
    /// registered (which would mean a stream-id collision — astronomically
    /// unlikely with UUIDs but possible if the frontend ever recycles a
    /// known id), the old waiter is cancelled before being replaced so it
    /// can't keep running orphaned without a cancel handle.
    pub fn register(&self, id: String) -> Arc<Notify> {
        let n = Arc::new(Notify::new());
        if let Some(old) = self.inner.insert(id.clone(), n.clone()) {
            tracing::warn!(
                "stream registry: overwriting existing handle for `{id}` — cancelling the previous waiter"
            );
            old.notify_waiters();
        }
        n
    }

    pub fn cancel(&self, id: &str) {
        if let Some((_, n)) = self.inner.remove(id) {
            // `notify_one` stores a permit if no waiter is registered yet,
            // so a cancel issued in the tiny window between `register()`
            // returning the Arc and the provider task awaiting
            // `cancel.notified()` is consumed by the first poll instead
            // of being lost (which is what `notify_waiters` would do).
            n.notify_one();
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
    /// Stream ended normally (provider emitted EOF / `[DONE]`). Carries
    /// the same closing semantics as the prior version of this enum.
    Done,
    /// Stream was cancelled by the user (or by another command stopping
    /// the runner). Distinct from `Done` so the frontend can avoid
    /// pretending an interrupted generation finished naturally — useful
    /// for skipping the "Saved to memory" pulse and for the unread-dot
    /// gate, which both only make sense on real completions.
    Cancelled,
    Error { message: String },
    Metrics {
        tokens: u32,
        elapsed_ms: u64,
        tokens_per_second: f64,
    },
    /// The model asked to invoke an MCP tool. Emitted once per call, BEFORE
    /// the dispatcher actually runs the tool, so the UI can render a "calling
    /// `<tool>`…" placeholder before the result lands. `id` is the
    /// provider's call id (OpenAI provides one; for Ollama we synthesise
    /// `call_<turn>_<index>`), used by the frontend to pair the call with
    /// its matching `ToolResult`.
    ToolCall {
        id: String,
        server_id: String,
        server_name: String,
        tool: String,
        arguments: serde_json::Value,
    },
    /// Outcome of a `ToolCall`. `is_error` mirrors the MCP `isError` flag;
    /// `content` is the concatenated text content (or a stringified
    /// resource for non-text content). On a transport failure we still
    /// emit ToolResult with `is_error: true` and the error message in
    /// `content` so the model can see the failure and react.
    ///
    /// `attachments` carries any files the tool produced (today only the
    /// built-in `pdf` tool fills this — MCP servers leave it empty). The
    /// frontend appends them to the running assistant message so they
    /// render as file cards in the chat; they're **not** fed back to the
    /// model as part of the next turn's context.
    ToolResult {
        id: String,
        content: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<crate::mcp::Attachment>,
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
    /// User cancelled the admin operation mid-flight. The frontend
    /// surfaces this as "Cancelled" instead of a green check so the user
    /// doesn't think a partial pull finished successfully.
    Cancelled,
    Error {
        message: String,
    },
}
