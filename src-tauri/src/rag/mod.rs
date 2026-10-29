//! Retrieval over Library items and Space sources.
//!
//! * **Chunking** ([`chunk_text`]) — documents are cut into ~1,200-character
//!   pieces along paragraph, line and sentence boundaries, with a short
//!   overlap so a fact straddling a cut is still whole in one chunk.
//! * **Keyword index** — every chunk lands in an FTS5 table as it's written
//!   (see `db::library`), so retrieval works before, or without, an
//!   embedding model.
//! * **Embeddings** — the background [`indexer`] embeds chunks through Ollama
//!   or an OpenAI-compatible endpoint once a model is configured.
//! * **Search** ([`search`]) — BM25 and cosine rankings fused with
//!   reciprocal-rank fusion, scoped to the sources a chat actually has, then
//!   cut to a character budget.
//!
//! Vectors are compared by brute force in Rust. A personal library is
//! thousands of chunks, not millions, and scoping to one chat's sources
//! keeps each search to a fraction of that — well inside a few
//! milliseconds, without shipping a native vector extension on three
//! platforms.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::db::library::ChunkRow;
use crate::db::Database;

pub mod embed;
pub mod indexer;

/// Characters a chunk aims for. Roughly 300 tokens: small enough that a
/// handful of excerpts fit an 8k context, big enough to carry a whole
/// paragraph of meaning.
pub const CHUNK_TARGET: usize = 1200;
/// Characters carried over from the end of one chunk into the next.
const CHUNK_OVERLAP: usize = 200;

/// Boundaries tried, in order, when a paragraph is longer than a chunk.
/// Each keeps its separator attached to the piece before it. Chinese and
/// Japanese end sentences and clauses with full-width marks and no space;
/// without them a long CJK paragraph was hard-cut mid-sentence.
const SEPARATORS: [&str; 12] = [
    "\n", ". ", "? ", "! ", "。", "？", "！", "; ", "；", ", ", "，", " ",
];

struct Piece {
    text: String,
    /// Starts a new paragraph, so it joins the previous piece with a blank
    /// line rather than directly.
    para_start: bool,
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Cut `text` into retrieval chunks. Whitespace-only input yields none.
pub fn chunk_text(text: &str) -> Vec<String> {
    let text = text.replace("\r\n", "\n");
    let mut pieces = Vec::new();
    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        let start = pieces.len();
        split_to_fit(para, &SEPARATORS, &mut pieces);
        if let Some(first) = pieces.get_mut(start) {
            first.para_start = true;
        }
    }
    pack(pieces)
}

/// Split `s` into pieces no longer than [`CHUNK_TARGET`], trying each
/// separator in turn and hard-cutting only when none is left.
fn split_to_fit(s: &str, seps: &[&str], out: &mut Vec<Piece>) {
    if char_len(s) <= CHUNK_TARGET {
        out.push(Piece { text: s.to_string(), para_start: false });
        return;
    }
    let Some((sep, rest)) = seps.split_first() else {
        let chars: Vec<char> = s.chars().collect();
        for window in chars.chunks(CHUNK_TARGET) {
            out.push(Piece { text: window.iter().collect(), para_start: false });
        }
        return;
    };
    let parts: Vec<&str> = s.split_inclusive(sep).collect();
    if parts.len() == 1 {
        split_to_fit(s, rest, out);
        return;
    }
    for part in parts {
        split_to_fit(part, rest, out);
    }
}

/// Greedily pack pieces into chunks of up to [`CHUNK_TARGET`] characters,
/// seeding each new chunk with the tail of the previous one.
fn pack(pieces: Vec<Piece>) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    // Whether `cur` holds anything beyond the overlap carried over from the
    // previous chunk. One that doesn't would only repeat the end of the chunk
    // before it (a whitespace-only line followed by a long one used to emit
    // exactly that), so it's never emitted.
    let mut fresh = false;
    for piece in pieces {
        let joiner = if !cur.is_empty() && piece.para_start { "\n\n" } else { "" };
        if !cur.is_empty() && char_len(&cur) + joiner.len() + char_len(&piece.text) > CHUNK_TARGET {
            let tail = overlap_tail(&cur);
            if fresh {
                chunks.push(cur.trim().to_string());
            }
            cur = if char_len(&tail) + 2 + char_len(&piece.text) <= CHUNK_TARGET {
                tail
            } else {
                String::new()
            };
            fresh = false;
        }
        if !cur.is_empty() && piece.para_start {
            cur.push_str("\n\n");
        }
        cur.push_str(&piece.text);
        fresh |= !piece.text.trim().is_empty();
    }
    if fresh {
        chunks.push(cur.trim().to_string());
    }
    chunks
}

/// The last ~[`CHUNK_OVERLAP`] characters of `s`, starting on a word.
fn overlap_tail(s: &str) -> String {
    let n = char_len(s);
    if n <= CHUNK_OVERLAP {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - CHUNK_OVERLAP).collect();
    match tail.find(char::is_whitespace) {
        Some(at) => tail[at..].trim_start().to_string(),
        None => tail,
    }
}

/// Little-endian f32 bytes, the `rag_chunks.embedding` format.
pub fn vector_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn blob_to_vector(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Scale to unit length so cosine similarity is a plain dot product. A zero
/// vector comes back unchanged.
pub fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    v
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Turn free text into an FTS5 query: its distinct words, each quoted (so
/// FTS5 operators and punctuation in the input are inert), OR-ed together
/// and left to BM25 to rank. `None` when there's no word to search for.
pub fn build_fts_query(query: &str) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    let terms: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
        .map(|w| w.to_lowercase())
        .filter(|w| seen.insert(w.clone()))
        .take(32)
        .map(|w| format!("\"{w}\""))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

/// Reciprocal-rank fusion: each list contributes `1 / (K + rank)` per id, so
/// an id ranked well by both keyword and vector search beats one that only
/// one of them likes, without having to calibrate BM25 against cosine.
pub fn rrf(lists: &[Vec<i64>]) -> Vec<(i64, f32)> {
    const K: f32 = 60.0;
    let mut scores: HashMap<i64, f32> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(*id).or_default() += 1.0 / (K + rank as f32 + 1.0);
        }
    }
    let mut out: Vec<(i64, f32)> = scores.into_iter().collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

/// A document a search may draw from.
#[derive(Debug, Deserialize, Clone)]
pub struct DocRef {
    /// `"library"` or `"space_file"`.
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct SearchArgs {
    pub docs: Vec<DocRef>,
    pub query: String,
    /// Character budget for the returned excerpts.
    pub max_chars: usize,
    #[serde(default)]
    pub max_chunks: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    pub doc_kind: String,
    pub doc_id: String,
    pub seq: i64,
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// `"hybrid"` (keyword + embeddings), `"keyword"` or `"overview"` (no
    /// match, so the documents' opening chunks).
    pub method: &'static str,
    /// Something the user should know about the quality of this search —
    /// the embedding model failing, or the index still being built.
    pub warning: Option<String>,
}

const CANDIDATES: usize = 60;
const DEFAULT_MAX_CHUNKS: usize = 12;
/// How long sends go straight to keyword search after a query embedding
/// failed, rather than each waiting out the same timeout first.
const QUERY_COOLDOWN: Duration = Duration::from_secs(60);

/// The last query embedding that failed for the server's sake (unreachable,
/// hung, rate-limiting, the model missing), with the settings it was sent
/// with.
#[derive(Debug, Default)]
pub struct QueryCooldown(Option<(embed::EmbedConfig, Instant, String)>);

impl QueryCooldown {
    /// The failure to report instead of embedding a query with `cfg` at
    /// `now`: one with the same settings less than [`QUERY_COOLDOWN`] ago.
    /// New settings are tried straight away.
    pub fn active(&self, cfg: &embed::EmbedConfig, now: Instant) -> Option<&str> {
        let (sent, at, error) = self.0.as_ref()?;
        (sent == cfg && now.duration_since(*at) < QUERY_COOLDOWN).then_some(error.as_str())
    }

    /// Note how a query embedding with `cfg` ended at `at`. A success clears
    /// the record, and so does a refusal: that's about the query, not the
    /// server.
    pub fn record(&mut self, cfg: &embed::EmbedConfig, at: Instant, error: Option<&embed::EmbedError>) {
        self.0 = error.filter(|e| !e.refused).map(|e| (cfg.clone(), at, e.message.clone()));
    }
}

/// Search `args.docs` for excerpts relevant to `args.query`.
pub async fn search(
    db: Arc<Database>,
    http: &reqwest::Client,
    indexer: &indexer::Indexer,
    args: SearchArgs,
) -> Result<SearchResult, String> {
    let keys: Vec<String> = args.docs.iter().map(|d| format!("{}:{}", d.kind, d.id)).collect();
    let scope = serde_json::to_string(&keys).map_err(|e| e.to_string())?;

    let keyword = match build_fts_query(&args.query) {
        Some(q) => {
            let (db, scope) = (db.clone(), scope.clone());
            tokio::task::spawn_blocking(move || db.rag_keyword_search(&scope, &q, CANDIDATES))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        }
        None => Vec::new(),
    };

    let mut warning = None;
    let mut semantic = Vec::new();
    let mut used_vectors = false;
    if let Some(cfg) = embed::EmbedConfig::from_db(&db) {
        let key = cfg.model_key();
        let (db2, scope2, k) = (db.clone(), scope.clone(), key.clone());
        let (vectors, total, pending) = tokio::task::spawn_blocking(move || db2.rag_vectors(&scope2, &k))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        // Chunks the model refused stay unembedded for good, so the warning
        // follows what the indexer still has to do.
        if pending > 0 {
            warning = Some(format!(
                "Still indexing — {} of {} excerpts searchable by meaning, the rest by keyword.",
                vectors.len(),
                total
            ));
        }
        // The query embedding sits on the send path, so skip it when it can't
        // pay off: the indexer's last request to this model failed, or the
        // last query embedding with these settings did a moment ago (the
        // server is down or the model missing — don't hold every send on
        // another try; the indexer retries on its own schedule), or nothing
        // in scope has a vector to compare against yet.
        let status = indexer.status();
        let failing = status
            .error
            .filter(|_| status.model.as_deref() == Some(key.as_str()))
            .or_else(|| indexer.query_cooldown.lock().active(&cfg, Instant::now()).map(str::to_string));
        if let Some(e) = failing {
            warning = Some(format!("Embedding model unavailable ({e}); searched by keyword only."));
        } else if !vectors.is_empty() {
            let result = embed::embed_query(http, &cfg, &args.query).await;
            indexer.query_cooldown.lock().record(&cfg, Instant::now(), result.as_ref().err());
            match result {
                Ok(q) => {
                    let mut scored: Vec<(i64, f32)> = vectors
                        .iter()
                        .filter(|(_, v)| v.len() == q.len())
                        .map(|(id, v)| (*id, dot(&q, v)))
                        .collect();
                    // Vectors of another length came from a different model
                    // under the same name (a re-pulled tag, a swapped
                    // server): they can't be compared, so say how to fix it
                    // rather than quietly searching by keyword.
                    let stale = vectors.len() - scored.len();
                    if stale > 0 {
                        warning = Some(format!(
                            "{stale} of {total} excerpts were embedded by a different version of the model — \
                             rebuild the index in Settings → Library to search them by meaning."
                        ));
                    }
                    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                    semantic = scored.into_iter().take(CANDIDATES).map(|(id, _)| id).collect();
                    used_vectors = !semantic.is_empty();
                }
                Err(e) => {
                    warning = Some(format!("Embedding model unavailable ({e}); searched by keyword only."));
                }
            }
        }
    }

    let mut method = if used_vectors { "hybrid" } else { "keyword" };
    let mut ranked = rrf(&[keyword, semantic]);
    if ranked.is_empty() {
        method = "overview";
        let (db2, scope2) = (db.clone(), scope.clone());
        let lead = tokio::task::spawn_blocking(move || db2.rag_leading_chunks(&scope2, 3))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        ranked = lead.into_iter().map(|id| (id, 0.0)).collect();
    }

    let max_chunks = args.max_chunks.unwrap_or(DEFAULT_MAX_CHUNKS);
    let candidates: Vec<(i64, f32)> = ranked.into_iter().take(max_chunks * 3).collect();
    let ids: Vec<i64> = candidates.iter().map(|(id, _)| *id).collect();
    let rows: Vec<ChunkRow> = tokio::task::spawn_blocking(move || db.rag_chunks_by_ids(&ids, &scope))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let score_of: HashMap<i64, f32> = candidates.into_iter().collect();

    let mut hits = Vec::new();
    let mut used = 0usize;
    for row in rows {
        let len = char_len(&row.text);
        if used + len > args.max_chars {
            // Keep looking: a shorter chunk further down may still fit.
            continue;
        }
        used += len;
        hits.push(SearchHit {
            score: score_of.get(&row.id).copied().unwrap_or(0.0),
            doc_kind: row.doc_kind,
            doc_id: row.doc_id,
            seq: row.seq,
            text: row.text,
        });
        if hits.len() >= max_chunks {
            break;
        }
    }
    Ok(SearchResult { hits, method, warning })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_paragraphs_split_at_sentence_ends() {
        let sentence = "机器学习是人工智能的一个分支，它让计算机从数据中学习。";
        let text = sentence.repeat(80); // one paragraph, no spaces
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(char_len(c) <= CHUNK_TARGET, "chunk of {} chars", char_len(c));
            assert!(c.ends_with('。'), "cut mid-sentence: …{}", c.chars().rev().take(8).collect::<String>());
        }
    }

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(chunk_text("hello world"), vec!["hello world"]);
        assert!(chunk_text("  \n\n \r\n ").is_empty());
    }

    #[test]
    fn chunks_respect_target_and_keep_paragraphs() {
        let para = "word ".repeat(150); // 750 chars
        let text = format!("{para}\n\n{para}\n\n{para}");
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(char_len(c) <= CHUNK_TARGET, "chunk of {} chars", char_len(c));
        }
    }

    #[test]
    fn long_paragraph_splits_on_sentences_with_overlap() {
        let sentence = "The quick brown fox jumps over the lazy dog. ";
        let text = sentence.repeat(80); // ~3600 chars, one paragraph
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(char_len(c) <= CHUNK_TARGET);
        }
        // The overlap carries the end of one chunk into the next.
        let tail: String = chunks[0].chars().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect();
        assert!(chunks[1].contains(tail.trim()), "no overlap between chunks");
    }

    #[test]
    fn no_chunk_is_only_the_previous_ones_tail() {
        // Regression: a near-full line, a whitespace-only line, then a long
        // unbroken one emitted a chunk made of nothing but the first chunk's
        // overlap — the same text twice, spending excerpt budget.
        let text = format!("{}wo\n   \n{}", "word ".repeat(239), "y".repeat(1100));
        let chunks = chunk_text(&text);
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        for pair in chunks.windows(2) {
            assert!(!pair[0].contains(pair[1].as_str()), "chunk repeats its predecessor: {:?}", pair[1]);
        }
        assert!(chunks[1].starts_with('y'));
    }

    #[test]
    fn unbroken_text_is_hard_cut_on_char_boundaries() {
        let text = "ż".repeat(3000);
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(char_len(c) <= CHUNK_TARGET);
        }
    }

    #[test]
    fn fts_query_quotes_and_dedupes_terms() {
        assert_eq!(
            build_fts_query("What's the \"budget\" for Q3? budget!").as_deref(),
            Some("\"what\" OR \"the\" OR \"budget\" OR \"for\" OR \"q3\"")
        );
        assert_eq!(build_fts_query("? ! a"), None);
        // FTS5 syntax in the input is inert once quoted.
        assert_eq!(build_fts_query("NEAR(x y) OR -z").as_deref(), Some("\"near\" OR \"or\""));
    }

    #[test]
    fn rrf_rewards_agreement() {
        let fused = rrf(&[vec![1, 2, 3], vec![3, 4]]);
        assert_eq!(fused[0].0, 3, "id ranked by both lists wins");
        assert_eq!(fused.len(), 4);
    }

    // Regression: a fully embedded index publishes no error, so with the
    // embedding server unreachable every send waited out the connect or
    // query timeout before falling back to keyword search.
    #[test]
    fn a_failed_query_embedding_holds_off_the_next_for_a_while() {
        let cfg = |url: &str| embed::EmbedConfig { provider: "ollama".into(), model: "m".into(), base_url: url.into() };
        let (lan, local) = (cfg("http://lan:11434"), cfg("http://localhost:11434"));
        let down = embed::EmbedError { message: "error sending request".into(), refused: false };
        let t0 = Instant::now();
        let mut c = QueryCooldown::default();
        assert_eq!(c.active(&lan, t0), None);

        c.record(&lan, t0, Some(&down));
        assert_eq!(c.active(&lan, t0 + Duration::from_secs(30)), Some("error sending request"));
        // New settings are tried at once; the same ones again after a while.
        assert_eq!(c.active(&local, t0 + Duration::from_secs(30)), None);
        assert_eq!(c.active(&lan, t0 + QUERY_COOLDOWN), None);

        // A success clears it, and so does a refused query.
        c.record(&lan, t0, None);
        assert_eq!(c.active(&lan, t0), None);
        c.record(&lan, t0, Some(&down));
        c.record(&lan, t0, Some(&embed::EmbedError { message: "HTTP 400: too long".into(), refused: true }));
        assert_eq!(c.active(&lan, t0), None);
    }

    #[test]
    fn vectors_round_trip_and_normalize() {
        let v = normalize(vec![3.0, 4.0]);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        assert_eq!(blob_to_vector(&vector_to_blob(&v)), v);
        assert_eq!(normalize(vec![0.0, 0.0]), vec![0.0, 0.0]);
    }
}
