//! Library storage: items (texts, files, links), the datasets that group
//! them, the links that attach either to a Space or a chat, and the
//! retrieval index (`rag_chunks`) built over every text source — Library
//! items and a Space's own uploads alike. Lives beside `db.rs` as a child
//! module so it shares `Database`'s private connection handles without
//! growing that file further.
//!
//! Items are stored once and *referenced* everywhere: editing a text here
//! changes what every Space and chat linked to it sees on its next turn.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{Database, SnapshotData};

/// `rag_chunks.doc_kind` for a Library item.
pub const DOC_LIBRARY: &str = "library";
/// `rag_chunks.doc_kind` for one of a Space's own uploads.
pub const DOC_SPACE_FILE: &str = "space_file";

/// A Library item with its full body — what `library_get_items` returns and
/// what a snapshot carries. `content` is extracted text for `media: "text"`
/// and base64 for `media: "image"`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryItem {
    pub id: String,
    /// `"text"` (written in the Library), `"file"` (uploaded) or `"link"`.
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub mime: String,
    /// `"text"` or `"image"`.
    #[serde(default = "default_media")]
    pub media: String,
    pub content: String,
    /// Size of the original: file bytes, page bytes, or the text's UTF-8
    /// length.
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub fetched_at: Option<i64>,
    #[serde(default)]
    pub content_hash: String,
    /// Extraction or fetching hit a cap, so `content` is incomplete.
    #[serde(default)]
    pub truncated: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_media() -> String {
    "text".to_string()
}

/// A Library item without its body, for lists. `chars` sizes the body (0 for
/// images), `preview` is its opening for text cards, and `chunks` /
/// `embedded` report how far the retrieval index has got with it.
#[derive(Debug, Serialize, Clone)]
pub struct LibraryItemMeta {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub mime: String,
    pub media: String,
    pub size: i64,
    pub chars: i64,
    pub preview: String,
    pub url: Option<String>,
    pub fetched_at: Option<i64>,
    pub content_hash: String,
    pub truncated: bool,
    pub chunks: i64,
    pub embedded: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A named, ordered group of items. An item can sit in several datasets.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryDataset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub item_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One Library item or dataset linked into a Space or chat (`owner_id`).
/// Exactly one of `item_id` / `dataset_id` is set.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibrarySource {
    pub id: String,
    pub owner_id: String,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub dataset_id: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub position: i32,
    pub created_at: i64,
}

fn default_enabled() -> bool {
    true
}

/// What links to a set of items / datasets, for the delete confirmation.
#[derive(Debug, Serialize, Clone)]
pub struct LibraryUsage {
    pub spaces: Vec<String>,
    pub chats: i64,
}

/// Which kind of thing a [`LibrarySource`] is attached to. Maps to one of
/// two tables with identical shape, so the FK can cascade from its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceOwner {
    Space,
    Session,
}

impl SourceOwner {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "space" => Ok(Self::Space),
            "session" => Ok(Self::Session),
            other => Err(anyhow!("unknown source owner `{other}`")),
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Space => "space_library_sources",
            Self::Session => "session_library_sources",
        }
    }
}

/// Fields for a new Library item.
pub struct NewLibraryItem<'a> {
    pub kind: &'a str,
    pub title: &'a str,
    pub mime: &'a str,
    pub media: &'a str,
    pub content: &'a str,
    pub size: i64,
    pub url: Option<&'a str>,
    pub fetched_at: Option<i64>,
    pub truncated: bool,
}

/// A chunk waiting for an embedding, with the title of the document it came
/// from (embedding the title alongside lifts recall for "what does X say"
/// questions).
pub struct PendingChunk {
    pub id: i64,
    pub text: String,
    pub title: String,
}

/// A chunk id with its unit-length embedding.
pub type ChunkVector = (i64, Vec<f32>);

/// One row of the retrieval index.
#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub id: i64,
    pub doc_kind: String,
    pub doc_id: String,
    pub seq: i64,
    pub text: String,
}

/// Lowercase hex SHA-256 of an item body. The frontend computes the same
/// digest to spot a duplicate before uploading it.
pub fn content_hash(content: &str) -> String {
    Sha256::digest(content.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Rebuild the retrieval chunks for one document. Clearing first makes this
/// the single path for create, edit and refresh; the triggers keep the FTS
/// index in step. Embeddings are left NULL for the indexer to fill.
pub(super) fn replace_chunks(conn: &Connection, doc_kind: &str, doc_id: &str, text: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM rag_chunks WHERE doc_kind = ?1 AND doc_id = ?2",
        params![doc_kind, doc_id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT INTO rag_chunks (doc_kind, doc_id, seq, text) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (seq, chunk) in crate::rag::chunk_text(text).iter().enumerate() {
        stmt.execute(params![doc_kind, doc_id, seq as i64, chunk])?;
    }
    Ok(())
}

/// The newest chunk id: chunks written after it's read get higher ones.
fn last_chunk_id(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COALESCE(MAX(id), 0) FROM rag_chunks", [], |r| r.get(0))?)
}

/// Move chunks with ids up to `last` — one document's, or with `None` every
/// one — to fresh ids with no embedding, as if just written. Resetting in
/// place isn't enough: an indexer batch already in flight for the old ids
/// would store its stale vectors (the old title, the old model) right over
/// the reset. Ids are `AUTOINCREMENT`, never reused, so those writes now
/// land nowhere — and the copies get ids above `last`, out of the delete's
/// reach.
pub(super) fn reissue_chunks(conn: &Connection, doc: Option<(&str, &str)>, last: i64) -> Result<()> {
    let (kind, id) = doc.unzip();
    let filter = "id <= ?3 AND (?1 IS NULL OR (doc_kind = ?1 AND doc_id = ?2))";
    conn.execute(
        &format!(
            "INSERT INTO rag_chunks (doc_kind, doc_id, seq, text)
             SELECT doc_kind, doc_id, seq, text FROM rag_chunks WHERE {filter} ORDER BY id"
        ),
        params![kind, id, last],
    )?;
    conn.execute(&format!("DELETE FROM rag_chunks WHERE {filter}"), params![kind, id, last])?;
    Ok(())
}

/// Chunks [`Database::clear_rag_embeddings`] moves per transaction.
const REISSUE_BATCH: i64 = 500;

/// SQL keeping the chunks whose document is in the scope bound to `param`
/// (a JSON array of `kind:id` keys; a kind has no colon). Compared as the
/// `(doc_kind, doc_id)` pair, each document is looked up through
/// `idx_rag_chunks_doc` — comparing `doc_kind || ':' || doc_id` read every
/// chunk in the index, embedding and all, on every search.
fn in_scope(param: &str) -> String {
    format!(
        "(doc_kind, doc_id) IN (SELECT substr(value, 1, instr(value, ':') - 1),
                                       substr(value, instr(value, ':') + 1)
                                  FROM json_each({param}))"
    )
}

const ITEM_META_SELECT: &str = "
    SELECT i.id, i.kind, i.title, i.mime, i.media, i.size,
           CASE WHEN i.media = 'text' THEN LENGTH(i.content) ELSE 0 END,
           CASE WHEN i.media = 'text' THEN substr(i.content, 1, 280) ELSE '' END,
           i.url, i.fetched_at, i.content_hash, i.truncated,
           (SELECT COUNT(*) FROM rag_chunks c
             WHERE c.doc_kind = 'library' AND c.doc_id = i.id),
           (SELECT COUNT(*) FROM rag_chunks c
             WHERE c.doc_kind = 'library' AND c.doc_id = i.id AND c.embed_model = ?1),
           i.created_at, i.updated_at
    FROM library_items i";

fn item_meta_from_row(r: &rusqlite::Row) -> rusqlite::Result<LibraryItemMeta> {
    Ok(LibraryItemMeta {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        mime: r.get(3)?,
        media: r.get(4)?,
        size: r.get(5)?,
        chars: r.get(6)?,
        preview: r.get(7)?,
        url: r.get(8)?,
        fetched_at: r.get(9)?,
        content_hash: r.get(10)?,
        truncated: r.get::<_, i64>(11)? != 0,
        chunks: r.get(12)?,
        embedded: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

fn item_from_row(r: &rusqlite::Row) -> rusqlite::Result<LibraryItem> {
    Ok(LibraryItem {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        mime: r.get(3)?,
        media: r.get(4)?,
        content: r.get(5)?,
        size: r.get(6)?,
        url: r.get(7)?,
        fetched_at: r.get(8)?,
        content_hash: r.get(9)?,
        truncated: r.get::<_, i64>(10)? != 0,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

const ITEM_SELECT: &str = "SELECT id, kind, title, mime, media, content, size, url, fetched_at,
                                  content_hash, truncated, created_at, updated_at
                           FROM library_items";

fn source_from_row(r: &rusqlite::Row) -> rusqlite::Result<LibrarySource> {
    Ok(LibrarySource {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        item_id: r.get(2)?,
        dataset_id: r.get(3)?,
        enabled: r.get::<_, i64>(4)? != 0,
        position: r.get(5)?,
        created_at: r.get(6)?,
    })
}

/// Replay a snapshot's Library rows inside the restore transaction.
pub(super) fn restore_library(conn: &Connection, d: &SnapshotData) -> Result<()> {
    {
        let mut stmt = conn.prepare(
            "INSERT INTO library_items (id, kind, title, mime, media, content, size, url,
                                        fetched_at, content_hash, truncated, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for i in &d.library_items {
            // A hand-edited or old export may lack the digest; recompute so
            // duplicate detection keeps working on restored rows.
            let hash = if i.content_hash.is_empty() {
                content_hash(&i.content)
            } else {
                i.content_hash.clone()
            };
            stmt.execute(params![
                i.id,
                i.kind,
                i.title,
                i.mime,
                i.media,
                i.content,
                i.size,
                i.url,
                i.fetched_at,
                hash,
                i.truncated as i64,
                i.created_at,
                i.updated_at,
            ])?;
        }
    }
    for ds in &d.library_datasets {
        conn.execute(
            "INSERT INTO library_datasets (id, name, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ds.id, ds.name, ds.description, ds.created_at, ds.updated_at],
        )?;
        for (pos, item_id) in ds.item_ids.iter().enumerate() {
            conn.execute(
                "INSERT OR IGNORE INTO library_dataset_items (dataset_id, item_id, position)
                 VALUES (?1, ?2, ?3)",
                params![ds.id, item_id, pos as i64],
            )?;
        }
    }
    for (owner, rows) in [
        (SourceOwner::Space, &d.space_library_sources),
        (SourceOwner::Session, &d.session_library_sources),
    ] {
        let sql = format!(
            "INSERT OR IGNORE INTO {} (id, owner_id, item_id, dataset_id, enabled, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            owner.table()
        );
        for s in rows {
            conn.execute(
                &sql,
                params![
                    s.id,
                    s.owner_id,
                    s.item_id,
                    s.dataset_id,
                    s.enabled as i64,
                    s.position,
                    s.created_at
                ],
            )?;
        }
    }
    Ok(())
}

impl Database {
    // ------------ items ------------

    /// Every item, newest-edited first, without bodies. `embed_model` is the
    /// indexer's current model key, used to count embedded chunks.
    pub fn list_library_items(&self, embed_model: Option<&str>) -> Result<Vec<LibraryItemMeta>> {
        self.with_read(|conn| {
            let mut stmt =
                conn.prepare(&format!("{ITEM_META_SELECT} ORDER BY i.updated_at DESC"))?;
            let rows = stmt
                .query_map(params![embed_model], item_meta_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn library_item_meta(&self, id: &str, embed_model: Option<&str>) -> Result<LibraryItemMeta> {
        self.with_read(|conn| {
            conn.query_row(
                &format!("{ITEM_META_SELECT} WHERE i.id = ?2"),
                params![embed_model, id],
                item_meta_from_row,
            )
            .optional()?
            .ok_or_else(|| anyhow!("library item not found"))
        })
    }

    /// Full rows for `ids`, in the order asked for; unknown ids are skipped.
    pub fn get_library_items(&self, ids: &[String]) -> Result<Vec<LibraryItem>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(&format!("{ITEM_SELECT} WHERE id = ?1"))?;
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(item) = stmt.query_row(params![id], item_from_row).optional()? {
                    out.push(item);
                }
            }
            Ok(out)
        })
    }

    /// Every item with its body, for export.
    pub fn all_library_items(&self) -> Result<Vec<LibraryItem>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(&format!("{ITEM_SELECT} ORDER BY created_at"))?;
            let rows = stmt
                .query_map([], item_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn create_library_item(
        &self,
        item: &NewLibraryItem,
        embed_model: Option<&str>,
    ) -> Result<LibraryItemMeta> {
        if !matches!(item.kind, "text" | "file" | "link") {
            return Err(anyhow!("unknown library item kind `{}`", item.kind));
        }
        if !matches!(item.media, "text" | "image") {
            return Err(anyhow!("unknown library media `{}`", item.media));
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO library_items (id, kind, title, mime, media, content, size, url,
                                            fetched_at, content_hash, truncated, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    id,
                    item.kind,
                    item.title,
                    item.mime,
                    item.media,
                    item.content,
                    item.size,
                    item.url,
                    item.fetched_at,
                    content_hash(item.content),
                    item.truncated as i64,
                    now,
                ],
            )?;
            if item.media == "text" {
                replace_chunks(&tx, DOC_LIBRARY, &id, item.content)?;
            }
            tx.commit()?;
        }
        self.library_item_meta(&id, embed_model)
    }

    /// Rename an item and return its stored row. The indexer embeds each
    /// chunk with its document's title, so a real change also marks the
    /// item's chunks for re-embedding.
    pub fn rename_library_item(
        &self,
        id: &str,
        title: &str,
        embed_model: Option<&str>,
    ) -> Result<LibraryItemMeta> {
        let now = Utc::now().timestamp_millis();
        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            let changed = tx.execute(
                "UPDATE library_items SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title IS NOT ?1",
                params![title, now, id],
            )?;
            if changed > 0 {
                reissue_chunks(&tx, Some((DOC_LIBRARY, id)), last_chunk_id(&tx)?)?;
            }
            tx.commit()?;
        }
        self.library_item_meta(id, embed_model)
    }

    /// Replace an item's body (a text edited, a link re-fetched) and rebuild
    /// its chunks. `fetched_at` is only written when given.
    #[allow(clippy::too_many_arguments)]
    pub fn replace_library_content(
        &self,
        id: &str,
        title: Option<&str>,
        content: &str,
        mime: Option<&str>,
        size: i64,
        truncated: bool,
        fetched_at: Option<i64>,
        embed_model: Option<&str>,
    ) -> Result<LibraryItemMeta> {
        let now = Utc::now().timestamp_millis();
        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            let media: Option<String> = tx
                .query_row(
                    "SELECT media FROM library_items WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(media) = media else {
                return Err(anyhow!("library item not found"));
            };
            if media != "text" {
                return Err(anyhow!("only text items can be edited"));
            }
            tx.execute(
                "UPDATE library_items
                    SET title = COALESCE(?1, title), content = ?2, mime = COALESCE(?3, mime),
                        size = ?4, truncated = ?5, content_hash = ?6,
                        fetched_at = COALESCE(?7, fetched_at), updated_at = ?8
                  WHERE id = ?9",
                params![
                    title,
                    content,
                    mime,
                    size,
                    truncated as i64,
                    content_hash(content),
                    fetched_at,
                    now,
                    id
                ],
            )?;
            replace_chunks(&tx, DOC_LIBRARY, id, content)?;
            tx.commit()?;
        }
        self.library_item_meta(id, embed_model)
    }

    /// Delete items. Dataset memberships and Space / chat links cascade; the
    /// `library_items_rag_ad` trigger drops their chunks.
    pub fn delete_library_items(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM library_items WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ------------ datasets ------------

    pub fn list_library_datasets(&self) -> Result<Vec<LibraryDataset>> {
        self.with_read(|conn| {
            let mut members: HashMap<String, Vec<String>> = HashMap::new();
            let mut stmt = conn.prepare(
                "SELECT dataset_id, item_id FROM library_dataset_items
                 ORDER BY dataset_id, position, item_id",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (ds, item) = row?;
                members.entry(ds).or_default().push(item);
            }
            let mut stmt = conn.prepare(
                "SELECT id, name, description, created_at, updated_at
                 FROM library_datasets ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(LibraryDataset {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        description: r.get(2)?,
                        item_ids: Vec::new(),
                        created_at: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows
                .into_iter()
                .map(|mut d| {
                    d.item_ids = members.remove(&d.id).unwrap_or_default();
                    d
                })
                .collect())
        })
    }

    pub fn create_library_dataset(
        &self,
        name: &str,
        description: &str,
        item_ids: &[String],
    ) -> Result<LibraryDataset> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO library_datasets (id, name, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, description, now],
        )?;
        let item_ids = insert_members(&tx, &id, item_ids)?;
        tx.commit()?;
        Ok(LibraryDataset {
            id,
            name: name.to_string(),
            description: description.to_string(),
            item_ids,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_library_dataset(&self, id: &str, name: &str, description: &str) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE library_datasets SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, description, now, id],
        )?;
        Ok(())
    }

    /// Replace a dataset's members with `item_ids`, in that order. Covers
    /// add, remove and reorder with one call. Returns the stored list (ids
    /// that don't exist are dropped).
    pub fn set_library_dataset_items(&self, id: &str, item_ids: &[String]) -> Result<Vec<String>> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE library_datasets SET updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        if changed == 0 {
            return Err(anyhow!("dataset not found"));
        }
        tx.execute(
            "DELETE FROM library_dataset_items WHERE dataset_id = ?1",
            params![id],
        )?;
        let stored = insert_members(&tx, id, item_ids)?;
        tx.commit()?;
        Ok(stored)
    }

    /// Delete datasets. Their items stay in the Library; links to the
    /// datasets themselves cascade away.
    pub fn delete_library_dataset(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM library_datasets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------ links into Spaces and chats ------------

    pub fn list_library_sources(&self, owner: SourceOwner, owner_id: &str) -> Result<Vec<LibrarySource>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, owner_id, item_id, dataset_id, enabled, position, created_at
                 FROM {} WHERE owner_id = ?1 ORDER BY position, created_at",
                owner.table()
            ))?;
            let rows = stmt
                .query_map(params![owner_id], source_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn all_library_sources(&self, owner: SourceOwner) -> Result<Vec<LibrarySource>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, owner_id, item_id, dataset_id, enabled, position, created_at
                 FROM {} ORDER BY owner_id, position",
                owner.table()
            ))?;
            let rows = stmt
                .query_map([], source_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Link items and datasets to an owner, appended after what's there.
    /// Anything already linked is skipped. Returns the owner's full list.
    pub fn add_library_sources(
        &self,
        owner: SourceOwner,
        owner_id: &str,
        item_ids: &[String],
        dataset_ids: &[String],
    ) -> Result<Vec<LibrarySource>> {
        let now = Utc::now().timestamp_millis();
        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            let mut next: i64 = tx.query_row(
                &format!(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM {} WHERE owner_id = ?1",
                    owner.table()
                ),
                params![owner_id],
                |r| r.get(0),
            )?;
            // Ids that no longer resolve (deleted in another view meanwhile)
            // are skipped, as `insert_members` does, rather than failing the
            // whole batch on the foreign key.
            let sql = format!(
                "INSERT OR IGNORE INTO {} (id, owner_id, item_id, dataset_id, enabled, position, created_at)
                 SELECT ?1, ?2, ?3, ?4, 1, ?5, ?6
                  WHERE EXISTS (SELECT 1 FROM library_items WHERE id = ?3)
                     OR EXISTS (SELECT 1 FROM library_datasets WHERE id = ?4)",
                owner.table()
            );
            let refs = item_ids
                .iter()
                .map(|i| (Some(i.as_str()), None))
                .chain(dataset_ids.iter().map(|d| (None, Some(d.as_str()))));
            for (item, dataset) in refs {
                let added = tx.execute(
                    &sql,
                    params![Uuid::new_v4().to_string(), owner_id, item, dataset, next, now],
                )?;
                next += added as i64;
            }
            tx.commit()?;
        }
        self.list_library_sources(owner, owner_id)
    }

    pub fn remove_library_source(&self, owner: SourceOwner, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            &format!("DELETE FROM {} WHERE id = ?1", owner.table()),
            params![id],
        )?;
        Ok(())
    }

    pub fn set_library_source_enabled(&self, owner: SourceOwner, id: &str, enabled: bool) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            &format!("UPDATE {} SET enabled = ?1 WHERE id = ?2", owner.table()),
            params![enabled as i64, id],
        )?;
        Ok(())
    }

    /// Spaces (by name) and the number of chats that link any of the given
    /// items or datasets directly.
    pub fn library_usage(&self, item_ids: &[String], dataset_ids: &[String]) -> Result<LibraryUsage> {
        let items = serde_json::to_string(item_ids)?;
        let datasets = serde_json::to_string(dataset_ids)?;
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT s.name FROM space_library_sources l
                   JOIN spaces s ON s.id = l.owner_id
                  WHERE l.item_id IN (SELECT value FROM json_each(?1))
                     OR l.dataset_id IN (SELECT value FROM json_each(?2))
                  ORDER BY s.name COLLATE NOCASE",
            )?;
            let spaces = stmt
                .query_map(params![items, datasets], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let chats: i64 = conn.query_row(
                "SELECT COUNT(DISTINCT owner_id) FROM session_library_sources
                  WHERE item_id IN (SELECT value FROM json_each(?1))
                     OR dataset_id IN (SELECT value FROM json_each(?2))",
                params![items, datasets],
                |r| r.get(0),
            )?;
            Ok(LibraryUsage { spaces, chats })
        })
    }

    // ------------ retrieval index ------------

    /// Chunk every text document that has no chunks yet: rows from before
    /// the index existed, and everything after a restore (snapshots don't
    /// carry the index). Returns how many documents were chunked.
    ///
    /// This runs on every indexer wake, so finding the work reads only ids,
    /// through the read pool — never the document bodies. Those are read and
    /// chunked a few documents per transaction, so rebuilding a restored
    /// Library doesn't hold the write lock (and every send) for its whole
    /// length.
    pub fn backfill_rag_chunks(&self) -> Result<usize> {
        const BATCH: usize = 16;
        let todo: Vec<(&'static str, String)> = self.with_read(|conn| {
            let mut out = Vec::new();
            for (kind, sql) in [
                (
                    DOC_LIBRARY,
                    "SELECT i.id FROM library_items i
                      WHERE i.media = 'text'
                        AND NOT EXISTS (SELECT 1 FROM rag_chunks c
                                         WHERE c.doc_kind = 'library' AND c.doc_id = i.id)",
                ),
                (
                    DOC_SPACE_FILE,
                    "SELECT f.id FROM space_files f
                      WHERE f.kind = 'text'
                        AND NOT EXISTS (SELECT 1 FROM rag_chunks c
                                         WHERE c.doc_kind = 'space_file' AND c.doc_id = f.id)",
                ),
            ] {
                let mut stmt = conn.prepare(sql)?;
                for id in stmt.query_map([], |r| r.get::<_, String>(0))? {
                    out.push((kind, id?));
                }
            }
            Ok(out)
        })?;
        let mut chunked = 0;
        for batch in todo.chunks(BATCH) {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            for (kind, id) in batch {
                // Checked again inside the write: a document chunked since the
                // ids were read (edited, say) is left as it is.
                let sql = if *kind == DOC_LIBRARY {
                    "SELECT content FROM library_items WHERE id = ?1
                        AND NOT EXISTS (SELECT 1 FROM rag_chunks c
                                         WHERE c.doc_kind = 'library' AND c.doc_id = ?1)"
                } else {
                    "SELECT data FROM space_files WHERE id = ?1
                        AND NOT EXISTS (SELECT 1 FROM rag_chunks c
                                         WHERE c.doc_kind = 'space_file' AND c.doc_id = ?1)"
                };
                let text: Option<String> = tx.query_row(sql, params![id], |r| r.get(0)).optional()?;
                if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
                    replace_chunks(&tx, kind, id, &text)?;
                    chunked += 1;
                }
            }
            tx.commit()?;
        }
        Ok(chunked)
    }

    /// Up to `limit` chunks not yet embedded with `model`, oldest first.
    pub fn rag_pending_embeddings(&self, model: &str, limit: usize) -> Result<Vec<PendingChunk>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.text, COALESCE(li.title, sf.name, '')
                   FROM rag_chunks c
                   LEFT JOIN library_items li ON c.doc_kind = 'library' AND li.id = c.doc_id
                   LEFT JOIN space_files sf ON c.doc_kind = 'space_file' AND sf.id = c.doc_id
                  WHERE c.embed_model IS NOT ?1
                  ORDER BY c.id LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![model, limit as i64], |r| {
                    Ok(PendingChunk {
                        id: r.get(0)?,
                        text: r.get(1)?,
                        title: r.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Store unit-length embeddings. A chunk deleted or reissued meanwhile
    /// (its document edited, renamed or deleted, or the index rebuilt) simply
    /// updates nothing: chunk ids are never reused.
    pub fn store_rag_embeddings(&self, model: &str, rows: &[ChunkVector]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE rag_chunks SET embedding = ?1, embed_model = ?2 WHERE id = ?3",
            )?;
            for (id, v) in rows {
                stmt.execute(params![crate::rag::vector_to_blob(v), model, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Mark chunks the model refused or failed on, on their own, as done for
    /// `model`, without a vector, so they stop holding up the rest of the
    /// index. They stay keyword-searchable; an edit, new embedding settings
    /// or a rebuild gives them another try.
    pub fn skip_rag_chunks(&self, model: &str, ids: &[i64]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE rag_chunks SET embedding = NULL, embed_model = ?1 WHERE id = ?2",
            )?;
            for id in ids {
                stmt.execute(params![model, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Put the chunks [`skip_rag_chunks`](Self::skip_rag_chunks) set aside
    /// for `model` back in the queue — the embedding settings changed but
    /// kept the model (another server), so its vectors stay.
    pub fn retry_skipped_rag_chunks(&self, model: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE rag_chunks SET embed_model = NULL WHERE embed_model = ?1 AND embedding IS NULL",
            params![model],
        )?;
        Ok(())
    }

    /// `(total chunks, chunks done with model)` across the whole index —
    /// "done" includes chunks [`skip_rag_chunks`](Self::skip_rag_chunks) set aside.
    pub fn rag_counts(&self, model: Option<&str>) -> Result<(i64, i64)> {
        self.with_read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(embed_model = ?1), 0) FROM rag_chunks",
                params![model],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
    }

    /// Forget every embedding so the indexer re-embeds from scratch, by
    /// reissuing every chunk — [`REISSUE_BATCH`] per transaction, so
    /// rebuilding a large index doesn't hold the write lock (and every send)
    /// for its whole length, as one copy of the table did. Chunks written in
    /// between get ids above the starting point and are fresh already. Each
    /// batch moves its chunks whole, so a rebuild cut short leaves every
    /// chunk in the index once, the ones it didn't reach still on their old
    /// vectors until the next rebuild.
    pub fn clear_rag_embeddings(&self) -> Result<()> {
        let last = last_chunk_id(&self.conn.lock())?;
        loop {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            let upto: Option<i64> = tx.query_row(
                "SELECT MAX(id) FROM (SELECT id FROM rag_chunks WHERE id <= ?1 ORDER BY id LIMIT ?2)",
                params![last, REISSUE_BATCH],
                |r| r.get(0),
            )?;
            let Some(upto) = upto else {
                return Ok(());
            };
            reissue_chunks(&tx, None, upto)?;
            tx.commit()?;
        }
    }

    /// BM25-ranked chunk ids inside `scope` (a JSON array of `kind:id`
    /// strings), best first. `fts_query` must already be a valid FTS5
    /// expression (see `rag::build_fts_query`).
    pub fn rag_keyword_search(&self, scope: &str, fts_query: &str, limit: usize) -> Result<Vec<i64>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT c.id FROM rag_chunks_fts
                   JOIN rag_chunks c ON c.id = rag_chunks_fts.rowid
                  WHERE rag_chunks_fts MATCH ?1
                    AND (c.doc_kind || ':' || c.doc_id) IN (SELECT value FROM json_each(?2))
                  ORDER BY bm25(rag_chunks_fts) LIMIT ?3",
            )?;
            let rows = stmt
                .query_map(params![fts_query, scope, limit as i64], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// `(chunk id, embedding)` for every chunk in `scope` embedded with
    /// `model`, plus how many chunks in scope exist at all and how many of
    /// those the indexer hasn't reached yet.
    pub fn rag_vectors(&self, scope: &str, model: &str) -> Result<(Vec<ChunkVector>, i64, i64)> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, embedding FROM rag_chunks
                  WHERE embed_model = ?1 AND embedding IS NOT NULL AND {}",
                in_scope("?2")
            ))?;
            let rows = stmt
                .query_map(params![model, scope], |r| {
                    let blob: Vec<u8> = r.get(1)?;
                    Ok((r.get::<_, i64>(0)?, crate::rag::blob_to_vector(&blob)))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let (total, pending): (i64, i64) = conn.query_row(
                &format!(
                    "SELECT COUNT(*), COALESCE(SUM(embed_model IS NOT ?2), 0) FROM rag_chunks WHERE {}",
                    in_scope("?1")
                ),
                params![scope, model],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok((rows, total, pending))
        })
    }

    /// Chunk rows for `ids` still inside `scope`, in the order asked for.
    /// The ids were ranked a moment ago, so the scope is checked again in
    /// case a document left it meanwhile.
    pub fn rag_chunks_by_ids(&self, ids: &[i64], scope: &str) -> Result<Vec<ChunkRow>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, doc_kind, doc_id, seq, text FROM rag_chunks
                  WHERE id = ?1 AND (doc_kind || ':' || doc_id) IN (SELECT value FROM json_each(?2))",
            )?;
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(row) = stmt
                    .query_row(params![id, scope], |r| {
                        Ok(ChunkRow {
                            id: r.get(0)?,
                            doc_kind: r.get(1)?,
                            doc_id: r.get(2)?,
                            seq: r.get(3)?,
                            text: r.get(4)?,
                        })
                    })
                    .optional()?
                {
                    out.push(row);
                }
            }
            Ok(out)
        })
    }

    /// Opening chunks of every document in `scope`, interleaved so each
    /// document gets its first chunk before any gets its second. The
    /// fallback when nothing in scope matches the query at all.
    pub fn rag_leading_chunks(&self, scope: &str, per_doc: usize) -> Result<Vec<i64>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id FROM rag_chunks
                  WHERE seq < ?1 AND {}
                  ORDER BY seq, doc_kind, doc_id",
                in_scope("?2")
            ))?;
            let rows = stmt
                .query_map(params![per_doc as i64, scope], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }
}

/// Insert dataset members in order, skipping ids that aren't items.
fn insert_members(conn: &Connection, dataset_id: &str, item_ids: &[String]) -> Result<Vec<String>> {
    let mut stored = Vec::with_capacity(item_ids.len());
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO library_dataset_items (dataset_id, item_id, position)
         SELECT ?1, id, ?3 FROM library_items WHERE id = ?2",
    )?;
    for item_id in item_ids {
        if stmt.execute(params![dataset_id, item_id, stored.len() as i64])? > 0 {
            stored.push(item_id.clone());
        }
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_db() -> (Database, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db = Database::open(&dir.path().join("loach.db")).expect("open");
        db.migrate().expect("migrate");
        (db, dir)
    }

    fn text_item(db: &Database, title: &str, content: &str) -> LibraryItemMeta {
        db.create_library_item(
            &NewLibraryItem {
                kind: "text",
                title,
                mime: "text/markdown",
                media: "text",
                content,
                size: content.len() as i64,
                url: None,
                fetched_at: None,
                truncated: false,
            },
            None,
        )
        .expect("create item")
    }

    fn scope(keys: &[(&str, &str)]) -> String {
        let keys: Vec<String> = keys.iter().map(|(k, id)| format!("{k}:{id}")).collect();
        serde_json::to_string(&keys).unwrap()
    }

    #[test]
    fn items_are_chunked_and_keyword_searchable_within_scope() {
        let (db, _dir) = fresh_db();
        let body = "The marketing budget for Q3 is forty thousand euros.";
        let a = text_item(&db, "Budget", body);
        let b = text_item(&db, "Recipes", "Pierogi need flour, water and a potato filling.");
        assert_eq!(a.chunks, 1);
        assert_eq!(a.content_hash, content_hash(body));
        assert!(a.preview.starts_with("The marketing"));

        let q = crate::rag::build_fts_query("what is the budget").unwrap();
        let both = scope(&[(DOC_LIBRARY, &a.id), (DOC_LIBRARY, &b.id)]);
        assert_eq!(db.rag_keyword_search(&both, &q, 10).unwrap().len(), 1);
        // Out of scope, the matching item is invisible.
        let only_b = scope(&[(DOC_LIBRARY, &b.id)]);
        assert!(db.rag_keyword_search(&only_b, &q, 10).unwrap().is_empty());
        // Diacritics fold, so an unaccented query finds accented text
        // ("ł" is a letter of its own, not an accented "l", so it doesn't).
        let c = text_item(&db, "PL", "Zażółć gęślą jaźń");
        let q = crate::rag::build_fts_query("gesla").unwrap();
        let only_c = scope(&[(DOC_LIBRARY, &c.id)]);
        assert_eq!(db.rag_keyword_search(&only_c, &q, 10).unwrap().len(), 1);
    }

    #[test]
    fn editing_rechunks_and_deleting_drops_chunks() {
        let (db, _dir) = fresh_db();
        let a = text_item(&db, "Note", "alpha beta");
        let s = scope(&[(DOC_LIBRARY, &a.id)]);
        let alpha = crate::rag::build_fts_query("alpha").unwrap();
        let gamma = crate::rag::build_fts_query("gamma").unwrap();
        assert_eq!(db.rag_keyword_search(&s, &alpha, 5).unwrap().len(), 1);

        let meta = db
            .replace_library_content(&a.id, Some("Renamed"), "gamma delta", None, 11, false, None, None)
            .unwrap();
        assert_eq!(meta.title, "Renamed");
        assert!(db.rag_keyword_search(&s, &alpha, 5).unwrap().is_empty());
        assert_eq!(db.rag_keyword_search(&s, &gamma, 5).unwrap().len(), 1);

        db.delete_library_items(std::slice::from_ref(&a.id)).unwrap();
        assert_eq!(db.rag_counts(None).unwrap().0, 0);
        assert!(db.rag_keyword_search(&s, &gamma, 5).unwrap().is_empty());
    }

    #[test]
    fn datasets_keep_order_and_lose_deleted_items() {
        let (db, _dir) = fresh_db();
        let a = text_item(&db, "A", "a body");
        let b = text_item(&db, "B", "b body");
        let ds = db
            .create_library_dataset("Research", "", &[b.id.clone(), "missing".into(), a.id.clone()])
            .unwrap();
        assert_eq!(ds.item_ids, vec![b.id.clone(), a.id.clone()]);

        let stored = db.set_library_dataset_items(&ds.id, &[a.id.clone(), b.id.clone()]).unwrap();
        assert_eq!(stored, vec![a.id.clone(), b.id.clone()]);

        db.delete_library_items(std::slice::from_ref(&a.id)).unwrap();
        let listed = db.list_library_datasets().unwrap();
        assert_eq!(listed[0].item_ids, vec![b.id.clone()]);

        // Deleting the dataset leaves its items in the Library.
        db.delete_library_dataset(&ds.id).unwrap();
        assert_eq!(db.list_library_items(None).unwrap().len(), 1);
    }

    #[test]
    fn sources_dedupe_cascade_and_report_usage() {
        let (db, _dir) = fresh_db();
        let space = db.create_space("Thesis", "", "").unwrap();
        let chat = db.create_session("c", "ollama", "m", None, None).unwrap();
        let a = text_item(&db, "A", "a body");
        let ds = db.create_library_dataset("D", "", std::slice::from_ref(&a.id)).unwrap();

        let ids = vec![a.id.clone()];
        let dsids = vec![ds.id.clone()];
        let first = db.add_library_sources(SourceOwner::Space, &space.id, &ids, &dsids).unwrap();
        assert_eq!(first.len(), 2);
        // Linking the same things again is a no-op.
        let again = db.add_library_sources(SourceOwner::Space, &space.id, &ids, &dsids).unwrap();
        assert_eq!(again.len(), 2);
        db.add_library_sources(SourceOwner::Session, &chat.id, &ids, &[]).unwrap();

        let usage = db.library_usage(&ids, &[]).unwrap();
        assert_eq!(usage.spaces, vec!["Thesis".to_string()]);
        assert_eq!(usage.chats, 1);

        db.set_library_source_enabled(SourceOwner::Space, &first[0].id, false).unwrap();
        assert!(!db.list_library_sources(SourceOwner::Space, &space.id).unwrap()[0].enabled);

        // A fork carries the chat's sources with it.
        let fork = db.fork_session(&chat.id, None).unwrap();
        assert_eq!(db.list_library_sources(SourceOwner::Session, &fork.id).unwrap().len(), 1);

        // Deleting the item unlinks it everywhere; deleting the Space drops
        // its remaining links.
        db.delete_library_items(&ids).unwrap();
        assert_eq!(db.list_library_sources(SourceOwner::Space, &space.id).unwrap().len(), 1);
        assert!(db.list_library_sources(SourceOwner::Session, &chat.id).unwrap().is_empty());
        db.delete_space(&space.id).unwrap();
        assert!(db.all_library_sources(SourceOwner::Space).unwrap().is_empty());
    }

    #[test]
    fn backfill_chunks_a_whole_restored_library_in_batches() {
        let (db, _dir) = fresh_db();
        let ids: Vec<String> = (0..40)
            .map(|i| text_item(&db, &format!("T{i}"), &format!("body number {i}")).id)
            .collect();
        db.conn.lock().execute_batch("DELETE FROM rag_chunks").unwrap();
        // More documents than one batch, all chunked; then nothing left to do.
        assert_eq!(db.backfill_rag_chunks().unwrap(), 40);
        assert_eq!(db.backfill_rag_chunks().unwrap(), 0);
        let q = crate::rag::build_fts_query("number").unwrap();
        let keys: Vec<(&str, &str)> = ids.iter().map(|id| (DOC_LIBRARY, id.as_str())).collect();
        assert_eq!(db.rag_keyword_search(&scope(&keys), &q, 100).unwrap().len(), 40);
    }

    // Regression: one id deleted elsewhere failed the whole batch with a raw
    // "FOREIGN KEY constraint failed", so none of the others were linked.
    #[test]
    fn linking_skips_ids_that_no_longer_exist() {
        let (db, _dir) = fresh_db();
        let chat = db.create_session("c", "ollama", "m", None, None).unwrap();
        let a = text_item(&db, "A", "a body");
        let linked = db
            .add_library_sources(
                SourceOwner::Session,
                &chat.id,
                &[a.id.clone(), "gone-item".into()],
                &["gone-dataset".into()],
            )
            .unwrap();
        assert_eq!(linked.iter().map(|l| l.item_id.as_deref()).collect::<Vec<_>>(), vec![Some(a.id.as_str())]);
        // A missing owner is still an error, not a silent no-op.
        assert!(db.add_library_sources(SourceOwner::Session, "gone-chat", &[a.id.clone()], &[]).is_err());
    }

    #[test]
    fn space_files_join_the_index_and_leave_with_their_space() {
        let (db, _dir) = fresh_db();
        let space = db.create_space("S", "", "").unwrap();
        let f = db
            .add_space_file(&space.id, "notes.md", "text/markdown", "text", "kangaroo facts", 14, 0)
            .unwrap();
        db.add_space_file(&space.id, "pic.png", "image/png", "image", "iVBOR", 5, 1).unwrap();
        assert_eq!(db.rag_counts(None).unwrap().0, 1, "only the text file is chunked");
        let q = crate::rag::build_fts_query("kangaroo").unwrap();
        let s = scope(&[(DOC_SPACE_FILE, &f.id)]);
        assert_eq!(db.rag_keyword_search(&s, &q, 5).unwrap().len(), 1);

        db.set_space_file_enabled(&f.id, false).unwrap();
        assert!(!db.list_space_files(&space.id).unwrap()[0].enabled);

        db.delete_space(&space.id).unwrap();
        assert_eq!(db.rag_counts(None).unwrap().0, 0);
    }

    #[test]
    fn embeddings_are_tracked_per_model() {
        let (db, _dir) = fresh_db();
        text_item(&db, "A", "one");
        text_item(&db, "B", "two");
        let pending = db.rag_pending_embeddings("ollama:m1", 10).unwrap();
        assert_eq!(pending.len(), 2);
        assert!(!pending[0].title.is_empty());

        let rows: Vec<(i64, Vec<f32>)> = pending.iter().map(|c| (c.id, vec![1.0, 0.0])).collect();
        db.store_rag_embeddings("ollama:m1", &rows).unwrap();
        assert_eq!(db.rag_counts(Some("ollama:m1")).unwrap(), (2, 2));
        assert!(db.rag_pending_embeddings("ollama:m1", 10).unwrap().is_empty());
        // A different model sees everything as pending again.
        assert_eq!(db.rag_pending_embeddings("ollama:m2", 10).unwrap().len(), 2);

        db.clear_rag_embeddings().unwrap();
        assert_eq!(db.rag_counts(Some("ollama:m1")).unwrap(), (2, 0));
    }

    #[test]
    fn refused_chunks_are_set_aside_until_the_model_changes() {
        let (db, _dir) = fresh_db();
        let a = text_item(&db, "A", "one");
        let pending = db.rag_pending_embeddings("ollama:m1", 10).unwrap();
        db.skip_rag_chunks("ollama:m1", &[pending[0].id]).unwrap();

        // Done for this model: no longer pending, counted, but no vector.
        assert!(db.rag_pending_embeddings("ollama:m1", 10).unwrap().is_empty());
        assert_eq!(db.rag_counts(Some("ollama:m1")).unwrap(), (1, 1));
        let s = scope(&[(DOC_LIBRARY, &a.id)]);
        let (vectors, total, left) = db.rag_vectors(&s, "ollama:m1").unwrap();
        assert_eq!((vectors.len(), total, left), (0, 1, 0));
        // Another model gives it another try.
        assert_eq!(db.rag_pending_embeddings("ollama:m2", 10).unwrap().len(), 1);
    }

    // Regression: a chunk that failed every time held the lowest ids, so the
    // indexer asked for the same batch every minute and nothing after it was
    // ever embedded.
    #[test]
    fn a_chunk_set_aside_lets_the_queue_move_on_until_retried() {
        let (db, _dir) = fresh_db();
        let m = "ollama:m1";
        let a = text_item(&db, "A", "poison");
        let b = text_item(&db, "B", "fine");
        let first = db.rag_pending_embeddings(m, 1).unwrap();
        db.skip_rag_chunks(m, &[first[0].id]).unwrap();
        assert_eq!(db.rag_pending_embeddings(m, 1).unwrap()[0].text, "fine", "the queue moved on");
        db.store_rag_embeddings(m, &in_flight(&db, m)).unwrap();
        // Not pending in the status, nor in a search's "still indexing".
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (2, 2));
        let s = scope(&[(DOC_LIBRARY, &a.id), (DOC_LIBRARY, &b.id)]);
        let (vectors, total, left) = db.rag_vectors(&s, m).unwrap();
        assert_eq!((vectors.len(), total, left), (1, 2, 0));

        // New settings for the same model: only the set-aside chunk is redone.
        db.retry_skipped_rag_chunks(m).unwrap();
        let again = db.rag_pending_embeddings(m, 10).unwrap();
        assert_eq!(again.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), vec!["poison"]);
        // A rebuild redoes everything, set-aside chunks included.
        db.skip_rag_chunks(m, &[again[0].id]).unwrap();
        db.clear_rag_embeddings().unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (2, 0));
    }

    // Development indexes keyed before the key named the server, like a
    // switch to another server, leave chunks under an old key: nothing done
    // under it — vectors or chunks set aside — may count as done under the
    // new one.
    #[test]
    fn a_new_key_requeues_vectors_and_set_aside_chunks() {
        let (db, _dir) = fresh_db();
        let (old, new) = ("ollama:m1", "ollama:m1@http://localhost:11434");
        let a = text_item(&db, "A", "one");
        let b = text_item(&db, "B", "two");
        let pending = db.rag_pending_embeddings(old, 10).unwrap();
        db.store_rag_embeddings(old, &[(pending[0].id, vec![1.0])]).unwrap();
        db.skip_rag_chunks(old, &[pending[1].id]).unwrap();
        assert_eq!(db.rag_counts(Some(old)).unwrap(), (2, 2));

        assert_eq!(db.rag_counts(Some(new)).unwrap(), (2, 0));
        assert_eq!(db.rag_pending_embeddings(new, 10).unwrap().len(), 2);
        let s = scope(&[(DOC_LIBRARY, &a.id), (DOC_LIBRARY, &b.id)]);
        let (vectors, total, left) = db.rag_vectors(&s, new).unwrap();
        assert_eq!((vectors.len(), total, left), (0, 2, 2));
        assert_eq!(db.library_item_meta(&a.id, Some(new)).unwrap().embedded, 0);
    }

    #[test]
    fn renaming_returns_the_row_and_re_embeds_only_on_change() {
        let (db, _dir) = fresh_db();
        let a = text_item(&db, "Old", "body");
        let ids: Vec<(i64, Vec<f32>)> = db
            .rag_pending_embeddings("ollama:m1", 10)
            .unwrap()
            .iter()
            .map(|c| (c.id, vec![1.0]))
            .collect();
        db.store_rag_embeddings("ollama:m1", &ids).unwrap();

        // Same title: nothing to redo.
        db.rename_library_item(&a.id, "Old", Some("ollama:m1")).unwrap();
        assert!(db.rag_pending_embeddings("ollama:m1", 10).unwrap().is_empty());

        let meta = db.rename_library_item(&a.id, "New", Some("ollama:m1")).unwrap();
        assert_eq!(meta.title, "New");
        assert_eq!(meta.embedded, 0);
        let pending = db.rag_pending_embeddings("ollama:m1", 10).unwrap();
        assert_eq!(pending[0].title, "New");
    }

    /// Ids of chunks still waiting for `model`, as an indexer batch reads them.
    fn in_flight(db: &Database, model: &str) -> Vec<ChunkVector> {
        db.rag_pending_embeddings(model, 100)
            .unwrap()
            .iter()
            .map(|c| (c.id, vec![1.0]))
            .collect()
    }

    // Regression: `rag_chunks.id` had no AUTOINCREMENT, so re-chunking the
    // newest document handed its deleted ids straight to the new chunks, and
    // an embedding in flight for the old text was stored on the new text.
    #[test]
    fn an_embedding_in_flight_never_lands_on_newer_text() {
        let (db, _dir) = fresh_db();
        let m = "ollama:m1";
        let a = text_item(&db, "Note", "old text about otters");
        let stale = in_flight(&db, m);

        // Edited while the batch is out: the vectors for the old text must
        // not be stored on the new chunks.
        db.replace_library_content(&a.id, None, "new text about badgers", None, 22, false, None, Some(m))
            .unwrap();
        db.store_rag_embeddings(m, &stale).unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (1, 0), "edited chunk still pending");

        // Deleted, then another document added: same story.
        let stale = in_flight(&db, m);
        db.delete_library_items(std::slice::from_ref(&a.id)).unwrap();
        let b = text_item(&db, "Other", "unrelated text");
        db.skip_rag_chunks(m, &stale.iter().map(|r| r.0).collect::<Vec<_>>()).unwrap();
        db.store_rag_embeddings(m, &stale).unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (1, 0), "new document's chunk still pending");
        assert_eq!(db.library_item_meta(&b.id, Some(m)).unwrap().embedded, 0);
    }

    // Regression: rename and Rebuild reset embeddings in place, so a batch in
    // flight from before (old title, old model) was stored right over the
    // reset and the chunk counted as done.
    #[test]
    fn rename_and_rebuild_outrun_a_batch_in_flight() {
        let (db, _dir) = fresh_db();
        let m = "ollama:m1";
        let a = text_item(&db, "Old title", "body about otters");
        let s = scope(&[(DOC_LIBRARY, &a.id)]);

        let stale = in_flight(&db, m);
        db.rename_library_item(&a.id, "New title", Some(m)).unwrap();
        db.store_rag_embeddings(m, &stale).unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (1, 0), "renamed chunk still pending");

        // Embed it for real, then Rebuild while a stale batch is out.
        db.store_rag_embeddings(m, &in_flight(&db, m)).unwrap();
        let stale: Vec<ChunkVector> =
            db.rag_vectors(&s, m).unwrap().0.into_iter().map(|(id, _)| (id, vec![0.5])).collect();
        db.clear_rag_embeddings().unwrap();
        db.store_rag_embeddings(m, &stale).unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (1, 0), "rebuilt chunk still pending");

        // The keyword index followed the chunks to their new ids.
        let q = crate::rag::build_fts_query("otters").unwrap();
        let hits = db.rag_keyword_search(&s, &q, 5).unwrap();
        assert_eq!(db.rag_chunks_by_ids(&hits, &s).unwrap()[0].text, "body about otters");
    }

    // Rebuild used to copy and delete the whole index in one transaction,
    // holding every send's writes for its length. A batch at a time, each
    // one — and a rebuild cut short between them — must leave every chunk in
    // the index exactly once.
    #[test]
    fn a_rebuild_moves_every_chunk_once_batch_by_batch() {
        let (db, _dir) = fresh_db();
        let m = "ollama:m1";
        let n = REISSUE_BATCH * 2 + 7;
        db.conn
            .lock()
            .execute(
                "WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?1)
                 INSERT INTO rag_chunks (doc_kind, doc_id, seq, text)
                 SELECT 'library', 'doc', i, 'excerpt ' || i FROM s",
                params![n],
            )
            .unwrap();
        let stale: Vec<ChunkVector> =
            db.rag_pending_embeddings(m, n as usize).unwrap().iter().map(|c| (c.id, vec![1.0])).collect();
        db.store_rag_embeddings(m, &stale).unwrap();
        let first = last_chunk_id(&db.conn.lock()).unwrap() - n + 1;
        let q = crate::rag::build_fts_query("excerpt").unwrap();
        let s = scope(&[(DOC_LIBRARY, "doc")]);
        let hits = |db: &Database| db.rag_keyword_search(&s, &q, n as usize + 1).unwrap().len() as i64;

        // Cut short after one batch: every chunk still there once, the keyword
        // index in step, the rest still on their old vectors.
        reissue_chunks(&db.conn.lock(), None, first + REISSUE_BATCH - 1).unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (n, n - REISSUE_BATCH));
        assert_eq!(hits(&db), n);

        db.clear_rag_embeddings().unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (n, 0));
        assert_eq!(hits(&db), n);
        let distinct: i64 = db
            .conn
            .lock()
            .query_row("SELECT COUNT(DISTINCT seq) FROM rag_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(distinct, n, "each chunk once");
        // A batch in flight from before lands nowhere.
        db.store_rag_embeddings(m, &stale).unwrap();
        assert_eq!(db.rag_counts(Some(m)).unwrap(), (n, 0));
    }

    // Regression: the scope was matched as `doc_kind || ':' || doc_id`, so
    // every search read the whole index, past each chunk's embedding.
    #[test]
    fn scoped_reads_look_documents_up_by_index() {
        let (db, _dir) = fresh_db();
        let m = "ollama:m1";
        let a = text_item(&db, "A", &"alpha ".repeat(400));
        let b = text_item(&db, "B", "beta");
        text_item(&db, "C", "gamma");
        db.store_rag_embeddings(m, &in_flight(&db, m)).unwrap();
        assert!(a.chunks >= 2);

        // Out-of-scope documents, a document listed twice and a key of the
        // wrong kind change nothing.
        let s = scope(&[(DOC_LIBRARY, &a.id), (DOC_LIBRARY, &b.id), (DOC_LIBRARY, &b.id), (DOC_SPACE_FILE, &a.id)]);
        let (vectors, total, left) = db.rag_vectors(&s, m).unwrap();
        assert_eq!((vectors.len() as i64, total, left), (a.chunks + 1, a.chunks + 1, 0));
        let lead = db.rag_leading_chunks(&s, 2).unwrap();
        let rows = db.rag_chunks_by_ids(&lead, &s).unwrap();
        assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![0, 0, 1]);
        assert_eq!(rows[2].doc_id, a.id);

        let plan: Vec<String> = {
            let conn = db.conn.lock();
            let mut stmt = conn
                .prepare(&format!("EXPLAIN QUERY PLAN SELECT id FROM rag_chunks WHERE {}", in_scope("?1")))
                .unwrap();
            stmt.query_map(params![s], |r| r.get(3)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert!(plan.iter().any(|d| d.contains("INDEX idx_rag_chunks_doc (doc_kind=? AND doc_id=?)")), "{plan:?}");
    }

    #[test]
    fn chunk_rows_are_read_back_only_within_scope() {
        let (db, _dir) = fresh_db();
        let a = text_item(&db, "A", "alpha");
        let b = text_item(&db, "B", "beta");
        let both = scope(&[(DOC_LIBRARY, &a.id), (DOC_LIBRARY, &b.id)]);
        let ids: Vec<i64> = db.rag_leading_chunks(&both, 1).unwrap();
        assert_eq!(ids.len(), 2);
        let only_a = scope(&[(DOC_LIBRARY, &a.id)]);
        let rows = db.rag_chunks_by_ids(&ids, &only_a).unwrap();
        assert_eq!(rows.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), vec!["alpha"]);
    }

    #[test]
    fn a_pre_release_index_without_autoincrement_is_rebuilt() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("loach.db");
        {
            let db = Database::open(&path).expect("open");
            db.migrate().expect("migrate");
            text_item(&db, "Kept", "a document from a development build");
            // The table as development builds of 1.6 created it.
            db.conn
                .lock()
                .execute_batch(
                    "DROP TABLE rag_chunks_fts; DROP TABLE rag_chunks;
                     CREATE TABLE rag_chunks (
                         id INTEGER PRIMARY KEY, doc_kind TEXT NOT NULL, doc_id TEXT NOT NULL,
                         seq INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB, embed_model TEXT
                     );",
                )
                .expect("simulate the old table");
        }
        let db = Database::open(&path).expect("reopen");
        db.migrate().expect("migrate rebuilds the index");
        let sql: String = db
            .conn
            .lock()
            .query_row("SELECT sql FROM sqlite_master WHERE name = 'rag_chunks'", [], |r| r.get(0))
            .unwrap();
        assert!(sql.contains("AUTOINCREMENT"), "{sql}");
        // The indexer's backfill re-chunks the documents into the new table.
        assert_eq!(db.backfill_rag_chunks().unwrap(), 1);
        let q = crate::rag::build_fts_query("development").unwrap();
        let all = scope(&[(DOC_LIBRARY, &db.list_library_items(None).unwrap()[0].id)]);
        assert_eq!(db.rag_keyword_search(&all, &q, 5).unwrap().len(), 1);
        db.migrate().expect("and stays idempotent");
    }

    #[test]
    fn snapshot_round_trips_library_and_index_is_rebuilt() {
        let (db, _dir) = fresh_db();
        let space = db.create_space("S", "", "").unwrap();
        db.set_space_retrieval_mode(&space.id, "retrieval").unwrap();
        let a = text_item(&db, "A", "walrus migration patterns");
        let ds = db.create_library_dataset("D", "desc", std::slice::from_ref(&a.id)).unwrap();
        db.add_library_sources(SourceOwner::Space, &space.id, &[], std::slice::from_ref(&ds.id))
            .unwrap();

        let json = serde_json::to_string(&db.snapshot().unwrap()).unwrap();
        // The export never carries the derived index.
        assert!(!json.contains("rag_chunks") && !json.contains("embedding"));

        db.wipe_user_data().unwrap();
        assert!(db.list_library_items(None).unwrap().is_empty());
        assert_eq!(db.rag_counts(None).unwrap().0, 0);

        let snap: crate::db::DatabaseSnapshot = serde_json::from_str(&json).unwrap();
        let stats = db.restore_snapshot(&snap).unwrap();
        assert_eq!((stats.library_items, stats.library_datasets), (1, 1));
        assert_eq!(db.list_library_datasets().unwrap()[0].item_ids, vec![a.id.clone()]);
        assert_eq!(db.list_library_sources(SourceOwner::Space, &space.id).unwrap().len(), 1);
        assert_eq!(db.get_space(&space.id).unwrap().unwrap().retrieval_mode, "retrieval");

        // Restored bodies have no chunks until the indexer backfills them.
        assert_eq!(db.rag_counts(None).unwrap().0, 0);
        assert_eq!(db.backfill_rag_chunks().unwrap(), 1);
        assert_eq!(db.rag_counts(None).unwrap().0, 1);
        assert_eq!(db.backfill_rag_chunks().unwrap(), 0);
    }

    #[test]
    fn older_snapshots_without_library_fields_still_load() {
        let (db, _dir) = fresh_db();
        let mut v = serde_json::to_value(db.snapshot().unwrap()).unwrap();
        let data = v["data"].as_object_mut().unwrap();
        for k in [
            "library_items",
            "library_datasets",
            "space_library_sources",
            "session_library_sources",
        ] {
            data.remove(k);
        }
        let snap: crate::db::DatabaseSnapshot = serde_json::from_value(v).unwrap();
        db.restore_snapshot(&snap).unwrap();
    }
}
