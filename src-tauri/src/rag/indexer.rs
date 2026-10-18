//! Background worker that keeps the retrieval index complete: it chunks any
//! document that has no chunks yet (rows from before the index existed, or
//! everything after a restore) and embeds every chunk that lacks a vector
//! from the configured model.
//!
//! Woken through [`Indexer::wake`] whenever something could have created work
//! — a source added or edited, the embedding model changed, a restore — and
//! otherwise asleep. Progress is broadcast on [`STATUS_EVENT`] so the Library
//! and Settings can show it.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use super::embed::{self, EmbedConfig};
use crate::db::Database;

/// Tauri event carrying an [`IndexStatus`] after every state change.
pub const STATUS_EVENT: &str = "library://index";

/// Chunks per embedding request.
const BATCH: usize = 16;
/// Wait before retrying after an embedding error, unless woken sooner (the
/// user fixing the model in Settings wakes the worker straight away).
const RETRY_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Clone, Default)]
pub struct IndexStatus {
    /// Model key (`provider:model`) chunks are embedded with; `None` when no
    /// embedding model is configured and the index is keyword-only.
    pub model: Option<String>,
    pub total: i64,
    pub embedded: i64,
    pub busy: bool,
    pub error: Option<String>,
}

pub struct Indexer {
    notify: Notify,
    status: Mutex<IndexStatus>,
}

impl Indexer {
    /// Start the worker and return its handle.
    pub fn spawn(app: AppHandle, db: Arc<Database>, http: reqwest::Client) -> Arc<Self> {
        let ix = Arc::new(Self {
            notify: Notify::new(),
            status: Mutex::new(IndexStatus::default()),
        });
        let worker = ix.clone();
        tauri::async_runtime::spawn(async move { worker.run(app, db, http).await });
        ix
    }

    /// Ask the worker to look for work. A wake while it's busy isn't lost:
    /// `notify_one` stores a permit the next wait consumes.
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    pub fn status(&self) -> IndexStatus {
        self.status.lock().clone()
    }

    fn publish(&self, app: &AppHandle, status: IndexStatus) {
        *self.status.lock() = status.clone();
        let _ = app.emit(STATUS_EVENT, status);
    }

    async fn run(self: Arc<Self>, app: AppHandle, db: Arc<Database>, http: reqwest::Client) {
        loop {
            // Once per wake, not per batch: new sources are chunked as
            // they're written, so this only finds rows from before the index
            // existed or from a restore.
            let d = db.clone();
            if let Err(e) = blocking(move || d.backfill_rag_chunks()).await {
                tracing::warn!("rag backfill failed: {e:?}");
            }
            match self.embed_pending(&app, &db, &http).await {
                Outcome::Idle => self.notify.notified().await,
                Outcome::Retry => {
                    tokio::select! {
                        _ = self.notify.notified() => {}
                        _ = tokio::time::sleep(RETRY_AFTER) => {}
                    }
                }
            }
        }
    }

    /// Embed batches until nothing is pending, or until something fails and
    /// the worker should pause before trying again.
    async fn embed_pending(&self, app: &AppHandle, db: &Arc<Database>, http: &reqwest::Client) -> Outcome {
        loop {
            let d = db.clone();
            let next = blocking(move || {
                let cfg = EmbedConfig::from_db(&d);
                let key = cfg.as_ref().map(EmbedConfig::model_key);
                let (total, embedded) = d.rag_counts(key.as_deref())?;
                let pending = match &key {
                    Some(k) => d.rag_pending_embeddings(k, BATCH)?,
                    None => Vec::new(),
                };
                Ok((cfg, total, embedded, pending))
            })
            .await;
            let (cfg, total, embedded, pending) = match next {
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!("rag pending query failed: {e:?}");
                    return Outcome::Retry;
                }
            };
            let Some(cfg) = cfg else {
                self.publish(app, IndexStatus { model: None, total, embedded, busy: false, error: None });
                return Outcome::Idle;
            };
            let key = cfg.model_key();
            if pending.is_empty() {
                self.publish(app, IndexStatus { model: Some(key), total, embedded, busy: false, error: None });
                return Outcome::Idle;
            }

            self.publish(app, IndexStatus { model: Some(key.clone()), total, embedded, busy: true, error: None });
            let inputs: Vec<String> = pending
                .iter()
                .map(|c| embed::document_input(&cfg, &c.title, &c.text))
                .collect();
            let (rows, skipped) = match embed::embed_batch(http, &cfg, &inputs).await {
                Ok(vectors) => (pending.iter().map(|c| c.id).zip(vectors).collect(), Vec::new()),
                // One input the model refuses fails the whole request, and the
                // same batch would come back every time. Go one by one so the
                // rest still get embedded.
                Err(e) if pending.len() > 1 => {
                    let mut rows = Vec::new();
                    let mut skipped = Vec::new();
                    let mut last = e;
                    for (c, input) in pending.iter().zip(&inputs) {
                        match embed::embed_batch(http, &cfg, std::slice::from_ref(input)).await {
                            Ok(mut v) => rows.extend(v.pop().map(|v| (c.id, v))),
                            Err(e) => {
                                skipped.push(c.id);
                                last = e;
                            }
                        }
                    }
                    if rows.is_empty() {
                        // Nothing went through on its own either, so it's
                        // the model or the server, not these inputs.
                        return self.fail(app, key, total, embedded, last);
                    }
                    if !skipped.is_empty() {
                        tracing::warn!(
                            "{key} refused {} chunk(s), left keyword-only: {last}",
                            skipped.len()
                        );
                    }
                    (rows, skipped)
                }
                Err(e) => return self.fail(app, key, total, embedded, e),
            };
            let (d, k) = (db.clone(), key.clone());
            let stored = blocking(move || {
                d.store_rag_embeddings(&k, &rows)?;
                d.skip_rag_chunks(&k, &skipped)
            })
            .await;
            if let Err(e) = stored {
                // Without a pause the same batch would be re-embedded at once,
                // over and over.
                return self.fail(app, key, total, embedded, format!("couldn't save embeddings: {e}"));
            }
        }
    }

    fn fail(&self, app: &AppHandle, key: String, total: i64, embedded: i64, error: String) -> Outcome {
        tracing::warn!("embedding with {key} failed: {error}");
        self.publish(app, IndexStatus { model: Some(key), total, embedded, busy: false, error: Some(error) });
        Outcome::Retry
    }
}

/// How a pass of [`Indexer::embed_pending`] ended.
enum Outcome {
    /// Nothing left to do; sleep until woken.
    Idle,
    /// Something failed; try again after [`RETRY_AFTER`] or a wake.
    Retry,
}

/// Run a blocking database call off the async runtime.
async fn blocking<T, F>(f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await?
}
