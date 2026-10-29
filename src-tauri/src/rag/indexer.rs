//! Background worker that keeps the retrieval index complete: it chunks any
//! document that has no chunks yet (rows from before the index existed, or
//! everything after a restore) and embeds every chunk that lacks a vector
//! from the configured model.
//!
//! Woken through [`Indexer::wake`] whenever something could have created work
//! — a source added or edited, the embedding model changed, a restore — and
//! otherwise asleep. Progress is broadcast on [`STATUS_EVENT`] so the Library
//! and Settings can show it.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use super::embed::{self, EmbedConfig, EmbedError};
use super::QueryCooldown;
use crate::db::library::ChunkVector;
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
    /// Model (`provider:model`, see [`EmbedConfig::model_label`]) chunks are
    /// embedded with; `None` when no embedding model is configured and the
    /// index is keyword-only.
    pub model: Option<String>,
    pub total: i64,
    pub embedded: i64,
    pub busy: bool,
    pub error: Option<String>,
}

pub struct Indexer {
    notify: Notify,
    status: Mutex<IndexStatus>,
    /// The send path's last failed query embedding (see `rag::search`).
    pub(super) query_cooldown: Mutex<QueryCooldown>,
}

impl Indexer {
    /// Start the worker and return its handle.
    pub fn spawn(app: AppHandle, db: Arc<Database>, http: reqwest::Client) -> Arc<Self> {
        let ix = Arc::new(Self {
            notify: Notify::new(),
            status: Mutex::new(IndexStatus::default()),
            query_cooldown: Mutex::new(QueryCooldown::default()),
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
        // The settings the last pass embedded with.
        let mut last = None;
        loop {
            // Once per wake, not per batch: new sources are chunked as
            // they're written, so this only finds rows from before the index
            // existed or from a restore.
            let d = db.clone();
            if let Err(e) = blocking(move || d.backfill_rag_chunks()).await {
                tracing::warn!("rag backfill failed: {e:?}");
            }
            match self.embed_pending(&app, &db, &http, &mut last).await {
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
    async fn embed_pending(
        &self,
        app: &AppHandle,
        db: &Arc<Database>,
        http: &reqwest::Client,
        last: &mut Option<EmbedConfig>,
    ) -> Outcome {
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
            let (key, label) = (cfg.model_key(), cfg.model_label());
            // Chunks are set aside for what one server made of them, so new
            // settings give them another try. New settings mostly mean a new
            // key, under which every chunk is pending anyway; this covers
            // settings that come back to an earlier key.
            if last.replace(cfg.clone()).is_some_and(|was| was != cfg) {
                let (d, k) = (db.clone(), key.clone());
                if let Err(e) = blocking(move || d.retry_skipped_rag_chunks(&k)).await {
                    tracing::warn!("rag retry of set-aside chunks failed: {e:?}");
                }
                continue;
            }
            if pending.is_empty() {
                self.publish(app, IndexStatus { model: Some(label), total, embedded, busy: false, error: None });
                return Outcome::Idle;
            }

            self.publish(app, IndexStatus { model: Some(label.clone()), total, embedded, busy: true, error: None });
            let inputs: Vec<String> = pending
                .iter()
                .map(|c| embed::document_input(&cfg, &c.title, &c.text))
                .collect();
            let Some(result) = self.embed_unless_reconfigured(db, http, &cfg, &inputs).await else {
                // The settings changed mid-request: start over on the new ones.
                continue;
            };
            let ids: Vec<i64> = pending.iter().map(|c| c.id).collect();
            let done = match result {
                Ok(vectors) => Isolated { rows: ids.into_iter().zip(vectors).collect(), ..Isolated::default() },
                // One input the server can't take fails the whole request, and
                // the same batch would come back every time.
                Err(e) => {
                    let cfg = &cfg;
                    isolate_failures(
                        &ids,
                        &inputs,
                        e,
                        move |input| async move { embed::embed_batch(http, cfg, std::slice::from_ref(&input)).await },
                        move || embed::probe(http, cfg),
                    )
                    .await
                }
            };
            if !done.set_aside.is_empty() {
                tracing::warn!("{key} couldn't embed {} chunk(s) on their own, left keyword-only", done.set_aside.len());
            }
            let Isolated { rows, set_aside, failure } = done;
            let (d, k) = (db.clone(), key);
            let stored = blocking(move || {
                d.store_rag_embeddings(&k, &rows)?;
                d.skip_rag_chunks(&k, &set_aside)
            })
            .await;
            if let Err(e) = stored {
                // Without a pause the same batch would be re-embedded at once,
                // over and over.
                return self.fail(app, label, total, embedded, format!("couldn't save embeddings: {e}"));
            }
            if let Some(e) = failure {
                return self.fail(app, label, total, embedded, e);
            }
        }
    }

    /// Embed `inputs`, unless the embedding settings change meanwhile — then
    /// `None`, so the pass restarts on the new settings instead of waiting out
    /// a request to a server the user just replaced (up to the 120 s embed
    /// timeout). A wake for anything else is handed on to the run loop.
    async fn embed_unless_reconfigured(
        &self,
        db: &Arc<Database>,
        http: &reqwest::Client,
        cfg: &EmbedConfig,
        inputs: &[String],
    ) -> Option<Result<Vec<Vec<f32>>, EmbedError>> {
        let request = embed::embed_batch(http, cfg, inputs);
        tokio::pin!(request);
        let mut woken = false;
        let out = loop {
            tokio::select! {
                r = &mut request => break Some(r),
                _ = self.notify.notified() => {
                    woken = true;
                    let d = db.clone();
                    let now = blocking(move || Ok(EmbedConfig::from_db(&d))).await.ok().flatten();
                    if now.as_ref() != Some(cfg) {
                        break None;
                    }
                }
            }
        };
        if woken {
            // The run loop backfills once per wake (a restore relies on it).
            self.notify.notify_one();
        }
        out
    }

    fn fail(&self, app: &AppHandle, label: String, total: i64, embedded: i64, error: String) -> Outcome {
        tracing::warn!("embedding with {label} failed: {error}");
        self.publish(app, IndexStatus { model: Some(label), total, embedded, busy: false, error: Some(error) });
        Outcome::Retry
    }
}

/// What came of a batch: vectors to store, chunks to set aside, and whether
/// the pass has to stop and retry later.
#[derive(Debug, Default)]
struct Isolated {
    rows: Vec<ChunkVector>,
    set_aside: Vec<i64>,
    failure: Option<String>,
}

/// The server turned a batch down (`batch`). Ask for each input on its own
/// (`embed_one`), so only the inputs that fail on their own are set aside
/// and the rest still get vectors. A refusal sets its input aside at once;
/// any other failure (a runner that crashes on that input, a vector missing
/// from the answer) only if `probe`, a trivial input sent right after, goes
/// through. If that fails too, the server went away or started
/// rate-limiting: stop, keeping the vectors that went through and setting
/// nothing aside, so an outage never marks a chunk done. When nothing went
/// through, `probe` also tells a model that can't embed at all (fail and
/// retry) from inputs it can't take (set aside).
async fn isolate_failures<E, EF, P, PF>(
    ids: &[i64],
    inputs: &[String],
    batch: EmbedError,
    mut embed_one: E,
    mut probe: P,
) -> Isolated
where
    E: FnMut(String) -> EF,
    EF: Future<Output = Result<Vec<Vec<f32>>, EmbedError>>,
    P: FnMut() -> PF,
    PF: Future<Output = Result<(), EmbedError>>,
{
    let mut out = Isolated::default();
    // Whether the model embedded anything, a probe included.
    let mut works = false;
    // A batch of one was this input on its own: how it fails is known.
    let mut known = (ids.len() == 1).then_some(batch);
    for (&id, input) in ids.iter().zip(inputs) {
        let result = match known.take() {
            Some(e) => Err(e),
            None => embed_one(input.clone()).await,
        };
        match result {
            Ok(mut v) => {
                works = true;
                out.rows.extend(v.pop().map(|v| (id, v)));
            }
            Err(e) if e.refused => out.set_aside.push(id),
            Err(e) => match probe().await {
                Ok(()) => {
                    works = true;
                    out.set_aside.push(id);
                }
                Err(_) => {
                    out.set_aside.clear();
                    out.failure = Some(e.message);
                    return out;
                }
            },
        }
    }
    if !works {
        if let Err(e) = probe().await {
            out.set_aside.clear();
            out.failure = Some(e.message);
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn ok() -> Result<Vec<Vec<f32>>, EmbedError> {
        Ok(vec![vec![1.0]])
    }
    fn refused() -> Result<Vec<Vec<f32>>, EmbedError> {
        Err(EmbedError { message: "HTTP 400: too long".into(), refused: true })
    }
    fn outage() -> Result<Vec<Vec<f32>>, EmbedError> {
        Err(EmbedError { message: "HTTP 429: rate limit".into(), refused: false })
    }
    fn crash() -> Result<Vec<Vec<f32>>, EmbedError> {
        Err(EmbedError { message: "HTTP 500: llama runner process has terminated".into(), refused: false })
    }

    /// Run [`isolate_failures`] over `ids` after the batch failed with
    /// `batch`, with scripted per-input answers and probe result; also
    /// returns how many single requests were made.
    async fn run(
        ids: &[i64],
        batch: Result<Vec<Vec<f32>>, EmbedError>,
        answers: Vec<Result<Vec<Vec<f32>>, EmbedError>>,
        probe_ok: bool,
    ) -> (Isolated, usize) {
        let inputs: Vec<String> = ids.iter().map(|i| format!("chunk {i}")).collect();
        let mut script = VecDeque::from(answers);
        let mut calls = 0;
        let out = isolate_failures(
            ids,
            &inputs,
            batch.unwrap_err(),
            |_input| {
                calls += 1;
                let r = script.pop_front().expect("more requests than scripted answers");
                async move { r }
            },
            || async move {
                if probe_ok {
                    Ok(())
                } else {
                    Err(EmbedError { message: "HTTP 400: model does not support embeddings".into(), refused: true })
                }
            },
        )
        .await;
        (out, calls)
    }

    #[tokio::test]
    async fn only_the_refused_inputs_are_set_aside() {
        let (out, _) = run(&[1, 2, 3], refused(), vec![ok(), refused(), ok()], true).await;
        assert_eq!(out.rows.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(out.set_aside, vec![2]);
        assert!(out.failure.is_none());
    }

    #[tokio::test]
    async fn an_outage_mid_way_sets_nothing_aside_and_stops_asking() {
        // Regression: any error on a single request used to mark that chunk
        // done for good, so a burst of 429s emptied the vector index while
        // the status read 100%.
        let (out, calls) = run(&[1, 2, 3, 4], refused(), vec![ok(), refused(), outage()], false).await;
        assert_eq!(calls, 3, "no requests after the outage");
        assert_eq!(out.rows.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1], "what went through is kept");
        assert!(out.set_aside.is_empty());
        assert_eq!(out.failure.as_deref(), Some("HTTP 429: rate limit"));
    }

    #[tokio::test]
    async fn an_input_that_fails_on_its_own_is_set_aside() {
        // Regression: only refusals were isolated, so an input that crashed
        // the runner failed its batch every minute forever, and nothing
        // after it was ever embedded.
        let (out, calls) = run(&[1, 2, 3], crash(), vec![ok(), crash(), ok()], true).await;
        assert_eq!(calls, 3);
        assert_eq!(out.rows.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(out.set_aside, vec![2]);
        assert!(out.failure.is_none());
        // A batch of one is the same case, without asking twice.
        let (out, calls) = run(&[7], crash(), vec![], true).await;
        assert_eq!((out.set_aside, calls), (vec![7], 0));
        // Unless the server can't embed anything either: then it's down.
        let (out, _) = run(&[7], crash(), vec![], false).await;
        assert!(out.set_aside.is_empty());
        assert_eq!(out.failure.as_deref(), Some("HTTP 500: llama runner process has terminated"));
    }

    #[tokio::test]
    async fn inputs_all_refused_by_a_working_model_are_set_aside() {
        // Regression: a batch whose every input was too long for the server
        // was retried every minute forever, holding up everything after it.
        let (out, _) = run(&[1, 2], refused(), vec![refused(), refused()], true).await;
        assert_eq!(out.set_aside, vec![1, 2]);
        assert!(out.failure.is_none());
        // A batch of one is the same case, without asking twice.
        let (out, calls) = run(&[7], refused(), vec![], true).await;
        assert_eq!((out.set_aside, calls), (vec![7], 0));
    }

    #[tokio::test]
    async fn a_model_that_embeds_nothing_fails_instead() {
        let (out, _) = run(&[1, 2], refused(), vec![refused(), refused()], false).await;
        assert!(out.set_aside.is_empty(), "a chat model picked as embedder must not mark the index done");
        assert_eq!(out.failure.as_deref(), Some("HTTP 400: model does not support embeddings"));
    }
}
