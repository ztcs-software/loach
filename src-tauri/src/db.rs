use std::path::Path;
// `parking_lot::Mutex` instead of `std::sync::Mutex` for two reasons:
//   1. No `PoisonError` to ignore on every lock — a panic inside one
//      command (e.g. an OOM during a query) shouldn't make every
//      subsequent DB call panic with "mutex poisoned".
//   2. Smaller, faster locks. Not a hot-path concern at the scale we
//      run, but free.
// The writer still uses a single Mutex<Connection>; reads on the hottest
// paths (list_sessions / list_messages / list_space_* / get_*) go
// through a small r2d2_sqlite pool instead so they don't queue behind
// every unrelated write. WAL mode lets readers + 1 writer run
// concurrently at the SQLite level — the mutex was the bottleneck, not
// SQLite itself.
use parking_lot::Mutex;

use anyhow::{Context, Result};
use chrono::Utc;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Pragmas applied to BOTH the writer connection and every pooled reader.
/// Skipped: `journal_mode = WAL` (persisted in the file header — only the
/// writer needs to set it, readers inherit) and `foreign_keys` (only
/// affects writes). Everything here is per-connection process-local tuning
/// — if a future pool connection forgets to run it, queries still return
/// correct results, just slower.
fn apply_perf_pragmas(conn: &Connection) {
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "temp_store", "MEMORY");
    let _ = conn.pragma_update(None, "cache_size", -20_000);
    let _ = conn.pragma_update(None, "mmap_size", 268_435_456i64);
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub params_json: Option<String>,
    #[serde(default)]
    pub space_id: Option<String>,
    #[serde(default)]
    pub pinned_at: Option<i64>,
    /// When non-null, the session is archived and hidden from the main chat
    /// list. The value is the ms-timestamp of when it was archived.
    #[serde(default)]
    pub archived_at: Option<i64>,
    /// Set when this session was created via `fork_session`. Points at the
    /// chat it was branched from. FK uses ON DELETE SET NULL — deleting the
    /// source clears the link so the fork survives on its own.
    #[serde(default)]
    pub forked_from_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    /// Per-space default provider ("ollama" | "openai"). When set together
    /// with `default_model`, new chats created inside the space land on
    /// this pair instead of the user's General Settings default. Null
    /// means "inherit the General Settings default".
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    /// JSON-encoded `GenerationParams` override for chats in this space.
    /// Layered between model defaults and per-session overrides — see
    /// `chatStore::readSessionParams`. Null means "inherit".
    #[serde(default)]
    pub default_params_json: Option<String>,
    /// When true, every assistant turn in this space runs through the
    /// extractor and any new facts are auto-saved as `space_memories`.
    /// Defaults to true on space creation; users can flip it off per-space
    /// from the Memory tab. Defaults to true on deserialization too, so
    /// older Loach exports that predate the field load with memory turned
    /// on (matching the behaviour an existing user would see post-migration).
    #[serde(default = "default_true")]
    pub memory_enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_true() -> bool {
    true
}

/// One free-text fact persisted across chats in a Space. The extractor
/// proposes new rows after each assistant turn; users can edit, delete, or
/// pin entries from the Memory tab. `source_session_id` / `source_message_id`
/// capture the chat that produced the row so the UI can link back; both go
/// NULL for memories the user authored manually.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpaceMemory {
    pub id: String,
    pub space_id: String,
    pub content: String,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpaceFile {
    pub id: String,
    pub space_id: String,
    pub name: String,
    pub mime: String,
    pub kind: String,
    pub data: String,
    pub size: i64,
    pub position: i32,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub attachments_json: Option<String>,
    /// Optional default provider ("ollama" | "openai") — when set, running the
    /// snippet creates a new chat pre-selected to this provider/model pair.
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// User-defined static substitution variable. The `key` is the uppercase
/// identifier the user references as `{{KEY}}` inside a snippet body; the
/// `value` is the text that replaces it at expansion time. `description`
/// is an optional human note (e.g. "Default project name"). Reserved keys
/// (`USER_NAME`, `CURRENT_*`) are rejected at the command layer so a custom
/// var can never silently shadow a built-in.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnippetVariable {
    pub id: String,
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Last value the user typed into a prompt-on-use placeholder for a given
/// snippet. Persisted so the fill-blanks dialog can pre-populate on the next
/// run instead of starting blank. Keyed by `(snippet_id, key)` — values for
/// the same key on different snippets stay independent. Cascades on snippet
/// delete so orphan rows don't accumulate.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnippetFillValue {
    pub snippet_id: String,
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

/// A user-configured MCP (Model Context Protocol) server. Loach only
/// speaks the Streamable-HTTP transport — one URL, POST JSON-RPC bodies,
/// optional auth headers. The underlying SQLite table still carries the
/// (now-unused) `transport` / `command` / `args_json` / `env_json` columns
/// from an earlier revision so migrations stay a no-op; new writes leave
/// them NULL.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    /// The endpoint URL (Streamable HTTP).
    pub url: String,
    /// JSON-encoded `{k: v}` map of request headers (typically
    /// `Authorization`, `X-API-Key`, etc.). Null means no headers.
    #[serde(default)]
    pub headers_json: Option<String>,
    /// When `false` the server is kept in the config but not surfaced to the
    /// model — lets users disable a flaky integration without losing its
    /// config.
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub attachments_json: Option<String>,
    #[serde(default)]
    pub metrics_json: Option<String>,
    /// JSON-encoded array of `ToolCallRecord` (see frontend `types.ts`):
    /// the MCP tool calls and their results threaded through this message
    /// during a multi-turn tool-use turn. Null on messages that didn't use
    /// any tools so old rows stay compact.
    ///
    /// `#[serde(default)]` is required so importing a snapshot exported by
    /// a pre-MCP build of Loach (where this field didn't exist) doesn't
    /// fail with "missing field" — the absent value rehydrates to None.
    #[serde(default)]
    pub tool_calls_json: Option<String>,
    /// Non-null = this message was rolled into an auto-summary by the
    /// Compact button at this ms-timestamp. The row stays in the DB and
    /// keeps rendering in the transcript so the user can still scroll
    /// back through it — but the chat-history builder skips it when
    /// constructing the next provider request, so the model only sees the
    /// summary block (in `session.system_prompt`) plus the trailing
    /// uncompacted turns. Null on every message until the user
    /// explicitly compacts.
    #[serde(default)]
    pub compacted_at: Option<i64>,
    /// Non-null = this message came from the "Import context" dialog. Every
    /// row of a single import shares one freshly-generated group id so the
    /// UI can render the batch as one collapsible card and remove it as a
    /// unit. Null on normal user/assistant/system turns.
    #[serde(default)]
    pub import_group: Option<String>,
    /// Only meaningful when `import_group` is set: `true` = the user chose
    /// to keep the imported batch folded out of the transcript. It still
    /// reaches the model exactly like a visible import — this flag governs
    /// display only.
    #[serde(default)]
    pub import_hidden: bool,
    pub created_at: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
    /// Read-only connection pool used by the hot SELECT paths. WAL mode
    /// already allows readers to run concurrently with the writer at the
    /// SQLite level — the bottleneck was the single Mutex serialising
    /// everything in-process. Pool is small on purpose: 4 readers is
    /// plenty for a desktop app and keeps the file-descriptor / mmap
    /// footprint modest.
    read_pool: Pool<SqliteConnectionManager>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("open sqlite")?;
        // WAL is persisted in the file header; only the writer needs to
        // set it, pooled readers inherit. Setting it here also ensures
        // the -wal / -shm sidecar files exist by the time the pool
        // opens its first connection.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Performance pragmas. All are durability-safe in combination with
        // WAL: `synchronous=NORMAL` keeps crash safety for the database (only
        // weakens the guarantee about the very last commit on power loss),
        // and the cache / mmap / temp-store knobs are pure local-process
        // tuning. None of them change on-disk format.
        apply_perf_pragmas(&conn);

        // Build the read pool. `with_init` reapplies the per-connection
        // performance pragmas to every checkout so a fresh reader gets
        // the same cache_size / mmap_size / synchronous as the writer.
        // `query_only=ON` makes the read-only contract enforceable: any
        // attempt to INSERT/UPDATE/DELETE/CREATE/DROP through a pooled
        // connection now errors at SQLite level instead of silently
        // succeeding and racing the writer. Connection-local PRAGMAs
        // (cache_size, mmap_size, …) are not "writes" and still apply,
        // and SELECTs against sqlite_master / sqlite_schema work fine.
        // We deliberately keep `max_size` small (4) — a desktop app has
        // a handful of concurrent UI panels, not server-grade
        // concurrency, and each connection holds its own mmap window.
        let manager = SqliteConnectionManager::file(path).with_init(|c| {
            apply_perf_pragmas(c);
            // Must run AFTER the perf pragmas. Pragmas like cache_size /
            // mmap_size aren't "writes" so query_only doesn't reject them,
            // but applying them first keeps the call order obvious if a
            // future SQLite tightens that classification.
            let _ = c.pragma_update(None, "query_only", "ON");
            Ok(())
        });
        let read_pool = Pool::builder()
            .max_size(4)
            // Don't block startup opening all 4 reader connections eagerly:
            // r2d2's `min_idle` defaults to `max_size`, so `build()` would open
            // and pragma-init every one (each runs the mmap_size pragma) on the
            // setup thread before first paint. Open them lazily on first SELECT
            // — which only happens post-unlock anyway. Trade-off: a reader that
            // fails to open then surfaces as a per-query "acquire read
            // connection" error rather than the friendly boot dialog, but the
            // writer open of the same file already catches the fatal cases at
            // startup.
            .min_idle(Some(0))
            .build(manager)
            .context("build read pool")?;

        Ok(Self {
            conn: Mutex::new(conn),
            read_pool,
        })
    }

    /// Run a read-only closure against a pooled connection. Use this for
    /// SELECT queries that don't need to coordinate with a write. The
    /// closure must not mutate the database — pool connections share the
    /// same file as the writer, and WAL gives them a consistent snapshot
    /// at the start of each statement. Mutations would race with the
    /// writer; use `self.conn.lock()` for writes.
    fn with_read<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&Connection) -> Result<R>,
    {
        let conn = self.read_pool.get().context("acquire read connection")?;
        f(&conn)
    }

    pub fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                system_prompt TEXT,
                params_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                attachments_json TEXT,
                metrics_json TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Spaces
            CREATE TABLE IF NOT EXISTS spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                instructions TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS space_files (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                mime TEXT NOT NULL,
                kind TEXT NOT NULL,
                data TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_space_files_space
                ON space_files(space_id, position);

            -- Snippets: reusable prompts with optional attachments.
            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                prompt TEXT NOT NULL,
                attachments_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snippets_updated
                ON snippets(updated_at DESC);

            -- MCP (Model Context Protocol) servers. Scope is always "user"
            -- (global to this install); we don't track per-project scope
            -- because Loach is a chat app, not a per-repo CLI.
            --
            -- `transport`, `command`, `args_json`, `env_json` are holdovers
            -- from when we also spoke stdio + SSE. Kept here so existing
            -- databases migrate cleanly; new rows leave them unset and the
            -- Rust struct no longer reads them.
            CREATE TABLE IF NOT EXISTS mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                transport TEXT NOT NULL DEFAULT 'http',
                command TEXT,
                args_json TEXT,
                env_json TEXT,
                url TEXT,
                headers_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mcp_servers_updated
                ON mcp_servers(updated_at DESC);
            "#,
        )?;

        // Column-existence probes go through `PRAGMA table_info(...)` rather
        // than the older `SELECT col FROM tbl LIMIT 0` + `.is_ok()` trick.
        // That trick conflates "column missing" with "any other prepare-
        // time error" (transient lock, schema-changed mid-transaction, …)
        // and on a false negative triggers a duplicate `ADD COLUMN` that
        // hard-fails the whole migrate. `table_info` returns rows we can
        // search authoritatively.
        if !has_column(&conn, "sessions", "space_id")? {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL;
                 CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions(space_id);",
            )?;
        }

        if !has_column(&conn, "sessions", "pinned_at")? {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;",
            )?;
        }

        if !has_column(&conn, "messages", "thinking")? {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN thinking TEXT;",
            )?;
        }

        // Tool calls + results made during an MCP-enabled assistant turn.
        // Stored as JSON on the assistant message so the transcript can be
        // re-rendered without re-running tools. Null for messages from
        // pre-MCP turns (and for user / system messages, which never have
        // tool calls).
        if !has_column(&conn, "messages", "tool_calls_json")? {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN tool_calls_json TEXT;",
            )?;
        }

        // `compacted_at`: ms-timestamp set by the Compact button on each
        // message that got rolled into the running auto-summary. Non-null
        // rows stay visible in the transcript but are excluded from the
        // outgoing chat history so the model only consumes the summary.
        // Null on every pre-existing row — older databases just keep
        // showing their full history with the next compaction free to
        // mark new rows.
        if !has_column(&conn, "messages", "compacted_at")? {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN compacted_at INTEGER;",
            )?;
        }

        // `import_group` / `import_hidden`: set on rows that came from the
        // "Import context" dialog. A shared group id lets the UI fold one
        // import into a single collapsible card and delete it as a unit;
        // `import_hidden` keeps that card out of the transcript while the
        // content still reaches the model. Both columns are added together,
        // so probing one is enough. Existing rows default to "not imported"
        // (NULL group, 0 hidden).
        if !has_column(&conn, "messages", "import_group")? {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN import_group TEXT;
                 ALTER TABLE messages ADD COLUMN import_hidden INTEGER NOT NULL DEFAULT 0;",
            )?;
        }

        // Add provider + model columns to snippets if missing (for pinning a
        // default model to a snippet).
        if !has_column(&conn, "snippets", "provider")? {
            conn.execute_batch(
                "ALTER TABLE snippets ADD COLUMN provider TEXT;
                 ALTER TABLE snippets ADD COLUMN model TEXT;",
            )?;
        }

        // Add archived_at column to sessions if missing. Null = live chat;
        // otherwise the ms-timestamp the session was archived.
        if !has_column(&conn, "sessions", "archived_at")? {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
                 CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at);",
            )?;
        }

        // Track which chat a session was forked from. Null = a normal chat
        // the user created directly; non-null = pointer back to the source
        // chat so the UI can show a "Forked" badge and a link back. FK uses
        // ON DELETE SET NULL so deleting the source orphans the fork's link
        // (and the badge falls off) without destroying the fork itself.
        if !has_column(&conn, "sessions", "forked_from_session_id")? {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;",
            )?;
        }

        // Add per-space default model + params columns if missing. Null =
        // "inherit from General Settings" — see the Space struct for the
        // full layering story.
        if !has_column(&conn, "spaces", "default_model")? {
            conn.execute_batch(
                "ALTER TABLE spaces ADD COLUMN default_provider TEXT;
                 ALTER TABLE spaces ADD COLUMN default_model TEXT;
                 ALTER TABLE spaces ADD COLUMN default_params_json TEXT;",
            )?;
        }

        // Add memory_enabled column to spaces if missing. Default ON so
        // existing spaces start collecting memory once the feature ships;
        // users can flip it off per-space.
        if !has_column(&conn, "spaces", "memory_enabled")? {
            conn.execute_batch(
                "ALTER TABLE spaces ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;",
            )?;
        }

        // Per-space free-text memory rows. Strict per-Space scope — chats
        // without a space never write here. Source pointers let the UI link
        // an auto-saved row back to the chat that produced it; manual entries
        // leave both NULL.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS space_memories (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                source_session_id TEXT,
                source_message_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_space_memories_space
                ON space_memories(space_id, created_at DESC);
            "#,
        )?;

        // Custom snippet variables.
        //   `snippet_variables` — user-defined KEY=VALUE pairs substituted into
        //   snippet bodies at expansion time. UNIQUE on `key` so the same name
        //   can't be defined twice; UI also normalises to uppercase before
        //   insert. Reserved-key collisions (`USER_NAME`, `CURRENT_*`) are
        //   blocked at the command layer.
        //
        //   `snippet_fill_values` — last value the user typed for each
        //   prompt-on-use placeholder on each snippet. Composite PK keeps
        //   recall scoped per-snippet so renaming a placeholder across
        //   snippets doesn't cross-contaminate. ON DELETE CASCADE on
        //   `snippet_id` means deleting a snippet drops its recall rows for
        //   free.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS snippet_variables (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL,
                description TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snippet_fill_values (
                snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (snippet_id, key)
            );
            "#,
        )?;

        Ok(())
    }

    // ------------ sessions ------------

    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, provider, model, system_prompt, params_json, space_id, pinned_at, archived_at, forked_from_session_id, created_at, updated_at
                 FROM sessions ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(Session {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        provider: r.get(2)?,
                        model: r.get(3)?,
                        system_prompt: r.get(4)?,
                        params_json: r.get(5)?,
                        space_id: r.get(6)?,
                        pinned_at: r.get(7)?,
                        archived_at: r.get(8)?,
                        forked_from_session_id: r.get(9)?,
                        created_at: r.get(10)?,
                        updated_at: r.get(11)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn create_session(
        &self,
        title: &str,
        provider: &str,
        model: &str,
        system_prompt: Option<&str>,
        space_id: Option<&str>,
    ) -> Result<Session> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO sessions (id, title, provider, model, system_prompt, params_json, space_id, forked_from_session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, ?7, ?7)",
            params![id, title, provider, model, system_prompt, space_id, now],
        )?;
        Ok(Session {
            id,
            title: title.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            system_prompt: system_prompt.map(|s| s.to_string()),
            params_json: None,
            space_id: space_id.map(|s| s.to_string()),
            pinned_at: None,
            archived_at: None,
            forked_from_session_id: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Create a new session as a fork of `source_id`, copying the source's
    /// title / provider / model / system prompt / params / space verbatim,
    /// and duplicating its messages up to (and including) `up_to_message_id`
    /// — or every message in the source when that arg is None.
    ///
    /// Message copies get fresh ids and a fresh session_id but keep the
    /// source's `created_at` so transcript ordering matches the original.
    /// `forked_from_session_id` is stamped on the new session so the UI can
    /// render the "Forked from …" badge and link back.
    pub fn fork_session(
        &self,
        source_id: &str,
        up_to_message_id: Option<&str>,
    ) -> Result<Session> {
        let source = self
            .get_session(source_id)?
            .ok_or_else(|| anyhow::anyhow!("source session not found"))?;

        let messages = self.list_messages(source_id)?;
        let take_until_idx = match up_to_message_id {
            None => messages.len(),
            Some(id) => {
                // Inclusive of the named message — "Fork from here" branches
                // *from* that turn, so the user can immediately reply with a
                // different follow-up.
                match messages.iter().position(|m| m.id == id) {
                    Some(i) => i + 1,
                    None => {
                        return Err(anyhow::anyhow!(
                            "up_to_message_id not found in source chat"
                        ));
                    }
                }
            }
        };
        let to_copy = &messages[..take_until_idx];

        let new_id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock();

        // Insert the new session row, then duplicate the selected messages —
        // all inside ONE transaction so a fork is atomic. Without it, a
        // message insert failing mid-loop (disk full, oversized row) left a
        // committed session holding a partial transcript while the command
        // returned Err, so the UI never navigated to it but the half-baked
        // chat lingered in the sidebar. Mirrors the transactional pattern in
        // `import_messages` / `mark_messages_compacted`.
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO sessions (id, title, provider, model, system_prompt, params_json,
                                   space_id, pinned_at, archived_at, forked_from_session_id,
                                   created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?9)",
            params![
                new_id,
                source.title,
                source.provider,
                source.model,
                source.system_prompt,
                source.params_json,
                source.space_id,
                source.id,
                now,
            ],
        )?;

        for m in to_copy {
            let msg_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO messages (id, session_id, role, content, thinking,
                                       attachments_json, metrics_json, tool_calls_json, compacted_at, created_at, import_group, import_hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    msg_id,
                    new_id,
                    m.role,
                    m.content,
                    m.thinking,
                    m.attachments_json,
                    m.metrics_json,
                    m.tool_calls_json,
                    m.compacted_at,
                    m.created_at,
                    m.import_group,
                    m.import_hidden,
                ],
            )?;
        }
        tx.commit()?;
        drop(conn);

        Ok(Session {
            id: new_id,
            title: source.title,
            provider: source.provider,
            model: source.model,
            system_prompt: source.system_prompt,
            params_json: source.params_json,
            space_id: source.space_id,
            pinned_at: None,
            archived_at: None,
            forked_from_session_id: Some(source.id),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn rename_session(&self, id: &str, title: &str) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;
        Ok(())
    }

    /// Update only the (provider, model) pair on a session. Leaves
    /// `system_prompt` and `params_json` untouched so a model swap doesn't
    /// silently clobber per-chat instructions or generation overrides.
    pub fn update_session_model(
        &self,
        id: &str,
        provider: &str,
        model: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET provider = ?1, model = ?2, updated_at = ?3 WHERE id = ?4",
            params![provider, model, now, id],
        )?;
        Ok(())
    }

    /// Update only the `system_prompt` column. Empty string is stored as
    /// empty (not NULL) so the round-trip back through `get_session` matches
    /// what the textarea last contained.
    pub fn update_session_system_prompt(&self, id: &str, prompt: &str) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET system_prompt = ?1, updated_at = ?2 WHERE id = ?3",
            params![prompt, now, id],
        )?;
        Ok(())
    }

    /// Update only the `params_json` column. `None` clears the override
    /// (session falls back to model defaults); `Some(json)` pins the supplied
    /// JSON blob.
    pub fn update_session_params(
        &self,
        id: &str,
        params_json: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET params_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![params_json, now, id],
        )?;
        Ok(())
    }

    pub fn pin_session(&self, id: &str, pinned: bool) -> Result<()> {
        let conn = self.conn.lock();
        let now = Utc::now().timestamp_millis();
        let pinned_at: Option<i64> = if pinned { Some(now) } else { None };
        // Bump `updated_at` too so the sidebar's `ORDER BY updated_at DESC`
        // surfaces the just-pinned chat to the top. Without this, pinning
        // a buried chat leaves it visually unchanged even though the
        // pinned-icon flipped on.
        conn.execute(
            "UPDATE sessions SET pinned_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![pinned_at, now, id],
        )?;
        Ok(())
    }

    pub fn archive_session(&self, id: &str, archived: bool) -> Result<()> {
        let conn = self.conn.lock();
        let now = Utc::now().timestamp_millis();
        let archived_at: Option<i64> = if archived { Some(now) } else { None };
        // Archiving also clears the pinned flag so an unarchived chat doesn't
        // silently re-appear as a pinned item. Bump `updated_at` so the
        // archive list is ordered by archive time and the active list
        // re-surfaces a just-restored chat.
        conn.execute(
            "UPDATE sessions SET archived_at = ?1,
                                 pinned_at = CASE WHEN ?1 IS NULL THEN pinned_at ELSE NULL END,
                                 updated_at = ?2
             WHERE id = ?3",
            params![archived_at, now, id],
        )?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, provider, model, system_prompt, params_json, space_id, pinned_at, archived_at, forked_from_session_id, created_at, updated_at
                 FROM sessions WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(r) = rows.next()? {
                Ok(Some(Session {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    provider: r.get(2)?,
                    model: r.get(3)?,
                    system_prompt: r.get(4)?,
                    params_json: r.get(5)?,
                    space_id: r.get(6)?,
                    pinned_at: r.get(7)?,
                    archived_at: r.get(8)?,
                    forked_from_session_id: r.get(9)?,
                    created_at: r.get(10)?,
                    updated_at: r.get(11)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    // ------------ messages ------------

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, role, content, thinking, attachments_json, metrics_json, tool_calls_json, compacted_at, created_at, import_group, import_hidden
                 FROM messages WHERE session_id = ?1 ORDER BY created_at ASC",
            )?;
            let rows = stmt
                .query_map(params![session_id], |r| {
                    Ok(Message {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        role: r.get(2)?,
                        content: r.get(3)?,
                        thinking: r.get(4)?,
                        attachments_json: r.get(5)?,
                        metrics_json: r.get(6)?,
                        tool_calls_json: r.get(7)?,
                        compacted_at: r.get(8)?,
                        created_at: r.get(9)?,
                        import_group: r.get(10)?,
                        import_hidden: r.get(11)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Per-session message counts in one indexed pass — `SELECT session_id,
    /// COUNT(*) ... GROUP BY session_id`, covered by `idx_messages_session`.
    /// Lets the frontend's startup empty-session cull learn which chats are
    /// empty without loading every session's full transcript (with inlined
    /// attachments) over IPC. Sessions with zero messages don't appear in the
    /// map (GROUP BY emits only sessions that have rows), so a missing key
    /// means count 0.
    pub fn session_message_counts(&self) -> Result<std::collections::HashMap<String, i64>> {
        self.with_read(|conn| {
            let mut stmt =
                conn.prepare("SELECT session_id, COUNT(*) FROM messages GROUP BY session_id")?;
            let map = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<std::collections::HashMap<String, i64>, _>>()?;
            Ok(map)
        })
    }

    pub fn append_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        attachments_json: Option<&str>,
    ) -> Result<Message> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        {
            // Insert the message and bump the session's sort timestamp in ONE
            // transaction: a single lock acquisition + a single WAL commit
            // rather than two (the old shape dropped the lock, then
            // `touch_session` reacquired it for a separate implicit commit).
            // Also tightens crash atomicity — a message can't land with its
            // session's updated_at left un-bumped.
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, metrics_json, tool_calls_json, compacted_at, created_at, import_group, import_hidden)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, NULL, 0)",
                params![id, session_id, role, content, attachments_json, now],
            )?;
            tx.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?;
            tx.commit()?;
        }
        Ok(Message {
            id,
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            thinking: None,
            attachments_json: attachments_json.map(|s| s.to_string()),
            metrics_json: None,
            tool_calls_json: None,
            compacted_at: None,
            created_at: now,
            import_group: None,
            import_hidden: false,
        })
    }

    /// Insert a batch of imported messages as one unit. Every row shares a
    /// freshly-generated `import_group` so the UI renders the batch as a
    /// single collapsible card and can delete it as a unit; `hidden`
    /// controls whether that card sits inline in the transcript or stays
    /// folded away — the content reaches the model either way. `created_at`
    /// steps forward one ms per row so ordering inside a single import is
    /// stable. Returns the inserted rows (with ids + timestamps) so the
    /// caller can splice them straight into the in-memory transcript.
    pub fn import_messages(
        &self,
        session_id: &str,
        items: &[(String, String)],
        hidden: bool,
    ) -> Result<Vec<Message>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let group = Uuid::new_v4().to_string();
        let base = Utc::now().timestamp_millis();
        let mut out = Vec::with_capacity(items.len());
        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, metrics_json, tool_calls_json, compacted_at, created_at, import_group, import_hidden)
                     VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, NULL, ?5, ?6, ?7)",
                )?;
                for (i, (role, content)) in items.iter().enumerate() {
                    let id = Uuid::new_v4().to_string();
                    let created_at = base + i as i64;
                    stmt.execute(params![id, session_id, role, content, created_at, group, hidden])?;
                    out.push(Message {
                        id,
                        session_id: session_id.to_string(),
                        role: role.clone(),
                        content: content.clone(),
                        thinking: None,
                        attachments_json: None,
                        metrics_json: None,
                        tool_calls_json: None,
                        compacted_at: None,
                        created_at,
                        import_group: Some(group.clone()),
                        import_hidden: hidden,
                    });
                }
            }
            // Bump the session's sort timestamp in the same transaction so the
            // import is one commit, not two (matches append_message).
            tx.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![base, session_id],
            )?;
            tx.commit()?;
        }
        Ok(out)
    }

    /// Delete every message belonging to one import batch. Scoped by
    /// `session_id` for the same defense-in-depth reason `delete_message`
    /// is. The 0-row case is silently accepted (the batch may already be
    /// gone).
    pub fn delete_import_group(&self, session_id: &str, group: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1 AND import_group = ?2",
            params![session_id, group],
        )?;
        Ok(())
    }

    /// Mark a batch of messages as compacted — sets `compacted_at = now`
    /// on every row whose id is in `ids` AND that belongs to
    /// `session_id`. The session filter is defensive (matches
    /// `delete_message` / `update_message`) so a leaked id can't reach
    /// across sessions. Rows that are already compacted have their
    /// timestamp left alone, since the divider should track the FIRST
    /// time a message left the model's context, not the most recent
    /// re-compaction.
    pub fn mark_messages_compacted(
        &self,
        session_id: &str,
        ids: &[String],
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE messages SET compacted_at = ?1
                 WHERE id = ?2 AND session_id = ?3 AND compacted_at IS NULL",
            )?;
            for id in ids {
                stmt.execute(params![now, id, session_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a single message. Scoped by `session_id` for the same
    /// defense-in-depth reason `update_message` is: a leaked or
    /// confused message id can't reach across sessions to delete an
    /// arbitrary row. The 0-row case is silently accepted — callers
    /// treat a miss as benign (the row may already be gone).
    pub fn delete_message(&self, id: &str, session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM messages WHERE id = ?1 AND session_id = ?2",
            params![id, session_id],
        )?;
        Ok(())
    }

    /// Delete every message in a session in a single statement — the atomic
    /// backing for the `/clear` command, replacing a per-message
    /// `delete_message` IPC loop. A lone `DELETE` is itself atomic, so a
    /// mid-clear failure can't leave the chat half-emptied. The 0-row case
    /// is silently accepted (an already-empty chat).
    pub fn clear_session_messages(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    pub fn update_message(
        &self,
        id: &str,
        session_id: &str,
        content: &str,
        thinking: Option<&str>,
        metrics_json: Option<&str>,
        tool_calls_json: Option<&str>,
        attachments_json: Option<&str>,
    ) -> Result<()> {
        // Scope by session_id so a renderer that ever gets confused — or a
        // compromised one calling commands directly with a leaked message id
        // — can't reach across sessions to mutate arbitrary messages. The
        // 0-row case is silently accepted because callers should treat a
        // miss as benign (the row may legitimately have been deleted under
        // them while the update was in flight).
        //
        // `tool_calls_json` is `COALESCE`'d the same way `metrics_json` is —
        // passing `None` preserves whatever's already on the row, so the
        // chat path can update content+thinking on the streaming flush
        // without clobbering tool-call records that were saved on a
        // separate write. `attachments_json` follows the same pattern so
        // tools that produce attachments (e.g. the built-in `pdf` tool)
        // can append them onto the assistant message without the next
        // streaming flush clobbering them back to NULL.
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE messages
             SET content = ?1,
                 thinking = ?2,
                 metrics_json = COALESCE(?3, metrics_json),
                 tool_calls_json = COALESCE(?4, tool_calls_json),
                 attachments_json = COALESCE(?5, attachments_json)
             WHERE id = ?6 AND session_id = ?7",
            params![content, thinking, metrics_json, tool_calls_json, attachments_json, id, session_id],
        )?;
        Ok(())
    }

    // ------------ settings ------------

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Fetch a single setting by key. Returns `None` when the row is
    /// missing so callers can apply their own default rather than guess
    /// from an empty string. Used by chat_stream to gate built-in tools
    /// (e.g. `calculate_tool_enabled`) without paying for the full
    /// `all_settings` scan on every turn.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.with_read(|conn| {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn all_settings(&self) -> Result<Vec<(String, String)>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    // ------------ spaces ------------

    pub fn list_spaces(&self) -> Result<Vec<Space>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, description, instructions,
                        default_provider, default_model, default_params_json,
                        memory_enabled, created_at, updated_at
                 FROM spaces ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(Space {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        description: r.get(2)?,
                        instructions: r.get(3)?,
                        default_provider: r.get(4)?,
                        default_model: r.get(5)?,
                        default_params_json: r.get(6)?,
                        memory_enabled: r.get::<_, i64>(7)? != 0,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_space(&self, id: &str) -> Result<Option<Space>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, description, instructions,
                        default_provider, default_model, default_params_json,
                        memory_enabled, created_at, updated_at
                 FROM spaces WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            if let Some(r) = rows.next()? {
                Ok(Some(Space {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    instructions: r.get(3)?,
                    default_provider: r.get(4)?,
                    default_model: r.get(5)?,
                    default_params_json: r.get(6)?,
                    memory_enabled: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn create_space(
        &self,
        name: &str,
        description: &str,
        instructions: &str,
    ) -> Result<Space> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO spaces (id, name, description, instructions, memory_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
            params![id, name, description, instructions, now],
        )?;
        Ok(Space {
            id,
            name: name.to_string(),
            description: description.to_string(),
            instructions: instructions.to_string(),
            default_provider: None,
            default_model: None,
            default_params_json: None,
            memory_enabled: true,
            created_at: now,
            updated_at: now,
        })
    }

    // 9 args matches the shape of the `spaces` table's editable columns
    // 1:1; refactoring to an args struct would only shift the noise to
    // the call site (commands.rs already deserialises into `UpdateSpaceArgs`
    // and then explodes it here). Suppressed rather than restructured.
    #[allow(clippy::too_many_arguments)]
    pub fn update_space(
        &self,
        id: &str,
        name: &str,
        description: &str,
        instructions: &str,
        default_provider: Option<&str>,
        default_model: Option<&str>,
        default_params_json: Option<&str>,
        memory_enabled: Option<bool>,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        // memory_enabled is optional so older callers (and the snippets-style
        // partial updates from the frontend) don't have to thread it through —
        // None means "leave the existing value alone".
        conn.execute(
            "UPDATE spaces SET name = ?1, description = ?2, instructions = ?3,
                               default_provider = ?4, default_model = ?5,
                               default_params_json = ?6,
                               memory_enabled = COALESCE(?7, memory_enabled),
                               updated_at = ?8
             WHERE id = ?9",
            params![
                name,
                description,
                instructions,
                default_provider,
                default_model,
                default_params_json,
                memory_enabled.map(|b| if b { 1_i64 } else { 0_i64 }),
                now,
                id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_space(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM spaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------ space files ------------

    pub fn list_space_files(&self, space_id: &str) -> Result<Vec<SpaceFile>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, space_id, name, mime, kind, data, size, position, created_at
                 FROM space_files WHERE space_id = ?1 ORDER BY position ASC",
            )?;
            let rows = stmt
                .query_map(params![space_id], |r| {
                    Ok(SpaceFile {
                        id: r.get(0)?,
                        space_id: r.get(1)?,
                        name: r.get(2)?,
                        mime: r.get(3)?,
                        kind: r.get(4)?,
                        data: r.get(5)?,
                        size: r.get(6)?,
                        position: r.get(7)?,
                        created_at: r.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    // Same rationale as `update_space`: column-shaped, single caller
    // (`commands::add_space_file`) that already has an `AddSpaceFileArgs`
    // struct on the other side of the IPC boundary.
    #[allow(clippy::too_many_arguments)]
    pub fn add_space_file(
        &self,
        space_id: &str,
        name: &str,
        mime: &str,
        kind: &str,
        data: &str,
        size: i64,
        position: i32,
    ) -> Result<SpaceFile> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO space_files (id, space_id, name, mime, kind, data, size, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, space_id, name, mime, kind, data, size, position, now],
        )?;
        Ok(SpaceFile {
            id,
            space_id: space_id.to_string(),
            name: name.to_string(),
            mime: mime.to_string(),
            kind: kind.to_string(),
            data: data.to_string(),
            size,
            position,
            created_at: now,
        })
    }

    pub fn remove_space_file(&self, file_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM space_files WHERE id = ?1", params![file_id])?;
        Ok(())
    }

    // ------------ space memories ------------

    pub fn list_space_memories(&self, space_id: &str) -> Result<Vec<SpaceMemory>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, space_id, content, source_session_id, source_message_id,
                        created_at, updated_at
                 FROM space_memories WHERE space_id = ?1 ORDER BY created_at ASC",
            )?;
            let rows = stmt
                .query_map(params![space_id], |r| {
                    Ok(SpaceMemory {
                        id: r.get(0)?,
                        space_id: r.get(1)?,
                        content: r.get(2)?,
                        source_session_id: r.get(3)?,
                        source_message_id: r.get(4)?,
                        created_at: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn add_space_memory(
        &self,
        space_id: &str,
        content: &str,
        source_session_id: Option<&str>,
        source_message_id: Option<&str>,
    ) -> Result<SpaceMemory> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO space_memories (id, space_id, content, source_session_id,
                                          source_message_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, space_id, content, source_session_id, source_message_id, now],
        )?;
        Ok(SpaceMemory {
            id,
            space_id: space_id.to_string(),
            content: content.to_string(),
            source_session_id: source_session_id.map(|s| s.to_string()),
            source_message_id: source_message_id.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_space_memory(&self, id: &str, space_id: &str, content: &str) -> Result<()> {
        // Scope by space_id — see the comment on `update_message` for the
        // same defense-in-depth rationale.
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE space_memories
             SET content = ?1, updated_at = ?2
             WHERE id = ?3 AND space_id = ?4",
            params![content, now, id, space_id],
        )?;
        Ok(())
    }

    pub fn remove_space_memory(&self, id: &str, space_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM space_memories WHERE id = ?1 AND space_id = ?2",
            params![id, space_id],
        )?;
        Ok(())
    }

    /// Read every memory across every space — used by the export path.
    pub fn all_space_memories(&self) -> Result<Vec<SpaceMemory>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, space_id, content, source_session_id, source_message_id,
                    created_at, updated_at
             FROM space_memories ORDER BY space_id, created_at",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SpaceMemory {
                    id: r.get(0)?,
                    space_id: r.get(1)?,
                    content: r.get(2)?,
                    source_session_id: r.get(3)?,
                    source_message_id: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ------------ snippets ------------

    pub fn list_snippets(&self) -> Result<Vec<Snippet>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, prompt, attachments_json, provider, model,
                        created_at, updated_at
                 FROM snippets ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(Snippet {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        prompt: r.get(2)?,
                        attachments_json: r.get(3)?,
                        provider: r.get(4)?,
                        model: r.get(5)?,
                        created_at: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn create_snippet(
        &self,
        title: &str,
        prompt: &str,
        attachments_json: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<Snippet> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO snippets (id, title, prompt, attachments_json, provider, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, title, prompt, attachments_json, provider, model, now],
        )?;
        Ok(Snippet {
            id,
            title: title.to_string(),
            prompt: prompt.to_string(),
            attachments_json: attachments_json.map(|s| s.to_string()),
            provider: provider.map(|s| s.to_string()),
            model: model.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_snippet(
        &self,
        id: &str,
        title: &str,
        prompt: &str,
        attachments_json: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE snippets SET title = ?1, prompt = ?2, attachments_json = ?3,
                                 provider = ?4, model = ?5, updated_at = ?6
             WHERE id = ?7",
            params![title, prompt, attachments_json, provider, model, now, id],
        )?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------ snippet variables ------------

    pub fn list_snippet_variables(&self) -> Result<Vec<SnippetVariable>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, key, value, description, created_at, updated_at
                 FROM snippet_variables ORDER BY key ASC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(SnippetVariable {
                        id: r.get(0)?,
                        key: r.get(1)?,
                        value: r.get(2)?,
                        description: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn create_snippet_variable(
        &self,
        key: &str,
        value: &str,
        description: Option<&str>,
    ) -> Result<SnippetVariable> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO snippet_variables (id, key, value, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, key, value, description, now],
        )?;
        Ok(SnippetVariable {
            id,
            key: key.to_string(),
            value: value.to_string(),
            description: description.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_snippet_variable(
        &self,
        id: &str,
        key: &str,
        value: &str,
        description: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE snippet_variables
             SET key = ?1, value = ?2, description = ?3, updated_at = ?4
             WHERE id = ?5",
            params![key, value, description, now, id],
        )?;
        Ok(())
    }

    pub fn delete_snippet_variable(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM snippet_variables WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // ------------ snippet fill values (prompt-on-use recall) ------------

    pub fn list_snippet_fill_values(
        &self,
        snippet_id: &str,
    ) -> Result<Vec<SnippetFillValue>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT snippet_id, key, value, updated_at
                 FROM snippet_fill_values WHERE snippet_id = ?1",
            )?;
            let rows = stmt
                .query_map(params![snippet_id], |r| {
                    Ok(SnippetFillValue {
                        snippet_id: r.get(0)?,
                        key: r.get(1)?,
                        value: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Every fill-value row across every snippet. Used by `snapshot()` to
    /// round-trip prompt-on-use recall through export / import; the
    /// per-snippet `list_snippet_fill_values` powers the live dialog.
    fn all_snippet_fill_values(&self) -> Result<Vec<SnippetFillValue>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT snippet_id, key, value, updated_at FROM snippet_fill_values",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(SnippetFillValue {
                        snippet_id: r.get(0)?,
                        key: r.get(1)?,
                        value: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Upsert a batch of `(key, value)` pairs for one snippet. The whole batch
    /// runs inside a single transaction so a partial write can't leave the
    /// recall row half-applied. Empty values are stored verbatim — the UI
    /// treats them as "no recall" but persisting them keeps round-trips
    /// idempotent.
    pub fn upsert_snippet_fill_values(
        &self,
        snippet_id: &str,
        values: &[(String, String)],
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for (k, v) in values {
            tx.execute(
                "INSERT INTO snippet_fill_values (snippet_id, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(snippet_id, key)
                 DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![snippet_id, k, v, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ------------ mcp servers ------------
    //
    // Only the HTTP transport is supported, so every row has a URL and the
    // legacy stdio-flavoured columns stay NULL.

    pub fn list_mcp_servers(&self) -> Result<Vec<McpServer>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, url, headers_json, enabled, created_at, updated_at
                 FROM mcp_servers ORDER BY name ASC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(McpServer {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        url: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        headers_json: r.get(3)?,
                        enabled: r.get::<_, i64>(4)? != 0,
                        created_at: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Upsert: create a new row if `id` is empty, otherwise update the
    /// existing one. Returns the row as it now stands in the DB.
    pub fn upsert_mcp_server(
        &self,
        id: Option<&str>,
        name: &str,
        url: &str,
        headers_json: Option<&str>,
        enabled: bool,
    ) -> Result<McpServer> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock();

        match id {
            Some(id) if !id.is_empty() => {
                conn.execute(
                    "UPDATE mcp_servers SET name = ?1, url = ?2, headers_json = ?3,
                                             enabled = ?4, updated_at = ?5
                     WHERE id = ?6",
                    params![
                        name,
                        url,
                        headers_json,
                        if enabled { 1_i64 } else { 0_i64 },
                        now,
                        id,
                    ],
                )?;
                let mut stmt =
                    conn.prepare("SELECT created_at FROM mcp_servers WHERE id = ?1")?;
                let created_at: i64 = stmt.query_row(params![id], |r| r.get(0))?;
                Ok(McpServer {
                    id: id.to_string(),
                    name: name.to_string(),
                    url: url.to_string(),
                    headers_json: headers_json.map(|s| s.to_string()),
                    enabled,
                    created_at,
                    updated_at: now,
                })
            }
            _ => {
                let new_id = Uuid::new_v4().to_string();
                // The legacy `transport` column is NOT NULL; hard-code it to
                // 'http' so inserts succeed on databases that were created
                // before the stdio/sse removal.
                conn.execute(
                    "INSERT INTO mcp_servers (id, name, transport, url, headers_json,
                                               enabled, created_at, updated_at)
                     VALUES (?1, ?2, 'http', ?3, ?4, ?5, ?6, ?6)",
                    params![
                        new_id,
                        name,
                        url,
                        headers_json,
                        if enabled { 1_i64 } else { 0_i64 },
                        now,
                    ],
                )?;
                Ok(McpServer {
                    id: new_id,
                    name: name.to_string(),
                    url: url.to_string(),
                    headers_json: headers_json.map(|s| s.to_string()),
                    enabled,
                    created_at: now,
                    updated_at: now,
                })
            }
        }
    }

    pub fn delete_mcp_server(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------ snapshot / wipe (Data tab) ------------
    //
    // The Data tab in Settings offers four operations: export, import,
    // archive-all, and erase. They all boil down to bulk reads or writes
    // that touch every table at once, which is why they live here rather
    // than being patched together from the per-entity helpers above.
    //
    // Export → `snapshot()` returns a `DatabaseSnapshot` that serialises
    // straight to JSON. Import → `restore_snapshot()` clears every table
    // then re-inserts in FK-safe order. Erase → `wipe_user_data()` clears
    // the user-owned tables (sessions/spaces/snippets/mcp) while leaving
    // `settings` alone; `wipe_all()` also drops `settings` for a true
    // factory reset.

    /// Read every message across every session. Used by the export path —
    /// callers normally fetch messages per-session.
    pub fn all_messages(&self) -> Result<Vec<Message>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, thinking, attachments_json, metrics_json, tool_calls_json, compacted_at, created_at, import_group, import_hidden
             FROM messages ORDER BY session_id, created_at",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Message {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    thinking: r.get(4)?,
                    attachments_json: r.get(5)?,
                    metrics_json: r.get(6)?,
                    tool_calls_json: r.get(7)?,
                    compacted_at: r.get(8)?,
                    created_at: r.get(9)?,
                    import_group: r.get(10)?,
                    import_hidden: r.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Read every space file across every space.
    pub fn all_space_files(&self) -> Result<Vec<SpaceFile>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, space_id, name, mime, kind, data, size, position, created_at
             FROM space_files ORDER BY space_id, position",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SpaceFile {
                    id: r.get(0)?,
                    space_id: r.get(1)?,
                    name: r.get(2)?,
                    mime: r.get(3)?,
                    kind: r.get(4)?,
                    data: r.get(5)?,
                    size: r.get(6)?,
                    position: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Capture the full database state in a plain data struct the frontend
    /// can ship to disk as JSON. `settings` is a key/value list — its
    /// shape is deliberately loose so future settings keys don't require
    /// a schema bump.
    ///
    /// **MCP credentials are scrubbed.** Each `mcp_servers` row's
    /// `headers_json` carries the user's bearer tokens / API keys for
    /// that integration. A snapshot is meant to be portable (backup,
    /// support handoff, hand-edited gist) so shipping credentials in
    /// plaintext would silently leak them whenever the user shared a
    /// dump. We blank the field at export time; the user must
    /// reconfigure auth after re-importing. The import path tolerates
    /// a NULL `headers_json` already (an MCP server with no auth headers
    /// is a valid configuration), so the round-trip remains valid.
    pub fn snapshot(&self) -> Result<DatabaseSnapshot> {
        let mcp_servers: Vec<McpServer> = self
            .list_mcp_servers()?
            .into_iter()
            .map(|mut s| {
                s.headers_json = None;
                s
            })
            .collect();
        Ok(DatabaseSnapshot {
            schema: "loach/v1".to_string(),
            exported_at: Utc::now().timestamp_millis(),
            loach_version: env!("CARGO_PKG_VERSION").to_string(),
            data: SnapshotData {
                sessions: self.list_sessions()?,
                messages: self.all_messages()?,
                spaces: self.list_spaces()?,
                space_files: self.all_space_files()?,
                space_memories: self.all_space_memories()?,
                snippets: self.list_snippets()?,
                snippet_variables: self.list_snippet_variables()?,
                snippet_fill_values: self.all_snippet_fill_values()?,
                mcp_servers,
                settings: self.all_settings()?,
            },
        })
    }

    /// Replace the contents of every table with the snapshot. Returns a
    /// row-count breakdown for the UI to display ("Imported 12 chats, 145
    /// messages, …"). FK enforcement is disabled for the duration so a
    /// snapshot that's missing e.g. a referenced space_id for a session
    /// still imports cleanly (the orphan FK becomes NULL at next write).
    ///
    /// `PRAGMA foreign_keys = ON` is restored on every exit path — including
    /// errors mid-import — so a bad snapshot can't leave the shared
    /// connection with FK enforcement disabled.
    pub fn restore_snapshot(&self, snap: &DatabaseSnapshot) -> Result<ImportStats> {
        let mut conn = self.conn.lock();

        // PRAGMA foreign_keys cannot be toggled inside a transaction, so
        // flip it before begin and restore after commit.
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let result = Self::restore_snapshot_locked(&mut conn, snap);
        if let Err(e) = conn.pragma_update(None, "foreign_keys", "ON") {
            tracing::error!("failed to re-enable foreign_keys after restore: {e:?}");
        }
        result
    }

    fn restore_snapshot_locked(
        conn: &mut Connection,
        snap: &DatabaseSnapshot,
    ) -> Result<ImportStats> {
        let tx = conn.transaction()?;
        // `snippet_fill_values` is deleted ahead of `snippets` so its FK to
        // `snippets(id)` is satisfied at delete time even with FK enforcement
        // toggled back on mid-transaction. `snippet_variables` is independent.
        tx.execute_batch(
            r#"
            DELETE FROM messages;
            DELETE FROM space_files;
            DELETE FROM space_memories;
            DELETE FROM sessions;
            DELETE FROM spaces;
            DELETE FROM snippet_fill_values;
            DELETE FROM snippet_variables;
            DELETE FROM snippets;
            DELETE FROM mcp_servers;
            DELETE FROM settings;
            "#,
        )?;

        let d = &snap.data;

        for s in &d.sessions {
            tx.execute(
                "INSERT INTO sessions (id, title, provider, model, system_prompt, params_json,
                                       space_id, pinned_at, archived_at, forked_from_session_id,
                                       created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    s.id,
                    s.title,
                    s.provider,
                    s.model,
                    s.system_prompt,
                    s.params_json,
                    s.space_id,
                    s.pinned_at,
                    s.archived_at,
                    s.forked_from_session_id,
                    s.created_at,
                    s.updated_at,
                ],
            )?;
        }

        for m in &d.messages {
            tx.execute(
                "INSERT INTO messages (id, session_id, role, content, thinking,
                                       attachments_json, metrics_json, tool_calls_json, compacted_at, created_at, import_group, import_hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    m.id,
                    m.session_id,
                    m.role,
                    m.content,
                    m.thinking,
                    m.attachments_json,
                    m.metrics_json,
                    m.tool_calls_json,
                    m.compacted_at,
                    m.created_at,
                    m.import_group,
                    m.import_hidden,
                ],
            )?;
        }

        for sp in &d.spaces {
            tx.execute(
                "INSERT INTO spaces (id, name, description, instructions,
                                     default_provider, default_model,
                                     default_params_json, memory_enabled,
                                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    sp.id,
                    sp.name,
                    sp.description,
                    sp.instructions,
                    sp.default_provider,
                    sp.default_model,
                    sp.default_params_json,
                    if sp.memory_enabled { 1_i64 } else { 0_i64 },
                    sp.created_at,
                    sp.updated_at,
                ],
            )?;
        }

        for mem in &d.space_memories {
            tx.execute(
                "INSERT INTO space_memories (id, space_id, content, source_session_id,
                                              source_message_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    mem.id,
                    mem.space_id,
                    mem.content,
                    mem.source_session_id,
                    mem.source_message_id,
                    mem.created_at,
                    mem.updated_at,
                ],
            )?;
        }

        for f in &d.space_files {
            tx.execute(
                "INSERT INTO space_files (id, space_id, name, mime, kind, data, size, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    f.id,
                    f.space_id,
                    f.name,
                    f.mime,
                    f.kind,
                    f.data,
                    f.size,
                    f.position,
                    f.created_at,
                ],
            )?;
        }

        for sn in &d.snippets {
            tx.execute(
                "INSERT INTO snippets (id, title, prompt, attachments_json, provider, model,
                                       created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    sn.id,
                    sn.title,
                    sn.prompt,
                    sn.attachments_json,
                    sn.provider,
                    sn.model,
                    sn.created_at,
                    sn.updated_at,
                ],
            )?;
        }

        for mcp in &d.mcp_servers {
            // Legacy `transport` column is NOT NULL — hard-code 'http' so
            // inserts succeed on databases that still carry the older schema.
            tx.execute(
                "INSERT INTO mcp_servers (id, name, transport, url, headers_json,
                                           enabled, created_at, updated_at)
                 VALUES (?1, ?2, 'http', ?3, ?4, ?5, ?6, ?7)",
                params![
                    mcp.id,
                    mcp.name,
                    mcp.url,
                    mcp.headers_json,
                    if mcp.enabled { 1_i64 } else { 0_i64 },
                    mcp.created_at,
                    mcp.updated_at,
                ],
            )?;
        }

        for v in &d.snippet_variables {
            tx.execute(
                "INSERT INTO snippet_variables (id, key, value, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![v.id, v.key, v.value, v.description, v.created_at, v.updated_at],
            )?;
        }

        for f in &d.snippet_fill_values {
            // `snippet_id` references `snippets(id)`. FK is OFF for this
            // transaction so an orphaned row imports cleanly — but with the
            // snippets table populated above, the common case lines up.
            tx.execute(
                "INSERT INTO snippet_fill_values (snippet_id, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(snippet_id, key)
                 DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![f.snippet_id, f.key, f.value, f.updated_at],
            )?;
        }

        for (k, v) in &d.settings {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            )?;
        }

        let stats = ImportStats {
            sessions: d.sessions.len(),
            messages: d.messages.len(),
            spaces: d.spaces.len(),
            space_files: d.space_files.len(),
            space_memories: d.space_memories.len(),
            snippets: d.snippets.len(),
            snippet_variables: d.snippet_variables.len(),
            snippet_fill_values: d.snippet_fill_values.len(),
            mcp_servers: d.mcp_servers.len(),
            settings: d.settings.len(),
        };

        tx.commit()?;
        Ok(stats)
    }

    /// Archive every session that isn't already archived. Pinned flags are
    /// cleared for parity with `archive_session`. Returns the number of
    /// rows that were newly archived so the UI can show a toast.
    pub fn archive_all_sessions(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let now = Utc::now().timestamp_millis();
        let affected = conn.execute(
            "UPDATE sessions SET archived_at = ?1, pinned_at = NULL
             WHERE archived_at IS NULL",
            params![now],
        )?;
        Ok(affected as i64)
    }

    /// Permanently delete every archived session (and their messages via
    /// ON DELETE CASCADE). Live chats are untouched. Returns the row count
    /// so the UI can confirm "Removed N chats".
    pub fn delete_archived_sessions(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let affected = conn.execute(
            "DELETE FROM sessions WHERE archived_at IS NOT NULL",
            [],
        )?;
        Ok(affected as i64)
    }

    /// Delete everything the user created (chats, spaces, snippets,
    /// MCP servers) while leaving app settings intact. `messages` and
    /// `space_files` fall via ON DELETE CASCADE.
    ///
    /// `PRAGMA foreign_keys = ON` is restored on every exit path so a mid-
    /// transaction failure can't leave the shared connection with FK
    /// enforcement disabled.
    pub fn wipe_user_data(&self) -> Result<()> {
        let mut conn = self.conn.lock();
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let result = Self::wipe_user_data_locked(&mut conn);
        if let Err(e) = conn.pragma_update(None, "foreign_keys", "ON") {
            tracing::error!("failed to re-enable foreign_keys after wipe_user_data: {e:?}");
        }
        result
    }

    fn wipe_user_data_locked(conn: &mut Connection) -> Result<()> {
        let tx = conn.transaction()?;
        // `snippet_fill_values` and `snippet_variables` are user-authored
        // content too — `wipe_user_data` is the "drop everything I made,
        // keep my settings" path, so they belong here. Without these two
        // DELETEs a wipe used to leave ghost variables behind that then
        // resurfaced on the next snippet run.
        tx.execute_batch(
            r#"
            DELETE FROM messages;
            DELETE FROM space_files;
            DELETE FROM space_memories;
            DELETE FROM sessions;
            DELETE FROM spaces;
            DELETE FROM snippet_fill_values;
            DELETE FROM snippet_variables;
            DELETE FROM snippets;
            DELETE FROM mcp_servers;
            "#,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Factory reset: everything `wipe_user_data` does, plus a settings
    /// purge. Caller is responsible for clearing the OS-kept OpenAI key
    /// since that lives outside SQLite.
    ///
    /// FK enforcement is restored on every exit path (see [`wipe_user_data`]).
    pub fn wipe_all(&self) -> Result<()> {
        let mut conn = self.conn.lock();
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let result = Self::wipe_all_locked(&mut conn);
        if let Err(e) = conn.pragma_update(None, "foreign_keys", "ON") {
            tracing::error!("failed to re-enable foreign_keys after wipe_all: {e:?}");
        }
        result
    }

    fn wipe_all_locked(conn: &mut Connection) -> Result<()> {
        let tx = conn.transaction()?;
        // `space_memories` is intentionally listed here even though `wipe_all`
        // used to rely on ON DELETE CASCADE from `spaces`: FK enforcement is
        // OFF for the duration of this transaction, so the cascade never
        // fires. Explicitly truncate the table so a factory reset really
        // does land back at zero rows.
        tx.execute_batch(
            r#"
            DELETE FROM messages;
            DELETE FROM space_files;
            DELETE FROM space_memories;
            DELETE FROM sessions;
            DELETE FROM spaces;
            DELETE FROM snippet_fill_values;
            DELETE FROM snippet_variables;
            DELETE FROM snippets;
            DELETE FROM mcp_servers;
            DELETE FROM settings;
            "#,
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DatabaseSnapshot {
    /// Wire-format tag — bump when the shape changes so loaders can
    /// reject or migrate older dumps.
    pub schema: String,
    pub exported_at: i64,
    pub loach_version: String,
    pub data: SnapshotData,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotData {
    pub sessions: Vec<Session>,
    pub messages: Vec<Message>,
    pub spaces: Vec<Space>,
    pub space_files: Vec<SpaceFile>,
    /// Per-space memory rows. Defaults to an empty list on older exports
    /// that predate the memory feature so loading them stays a no-op.
    #[serde(default)]
    pub space_memories: Vec<SpaceMemory>,
    pub snippets: Vec<Snippet>,
    /// User-defined `{{KEY}}` global variables. Defaults to empty on older
    /// exports that predate the feature so loading them stays a no-op.
    #[serde(default)]
    pub snippet_variables: Vec<SnippetVariable>,
    /// Per-snippet prompt-on-use recall. Empty on older exports.
    #[serde(default)]
    pub snippet_fill_values: Vec<SnippetFillValue>,
    pub mcp_servers: Vec<McpServer>,
    /// Key/value settings as stored in the `settings` table. A plain list
    /// (not a map) so round-trip order is stable.
    pub settings: Vec<(String, String)>,
}

/// Row-count breakdown returned after a successful import.
#[derive(Debug, Serialize)]
pub struct ImportStats {
    pub sessions: usize,
    pub messages: usize,
    pub spaces: usize,
    pub space_files: usize,
    pub space_memories: usize,
    pub snippets: usize,
    pub snippet_variables: usize,
    pub snippet_fill_values: usize,
    pub mcp_servers: usize,
    pub settings: usize,
}

/// Authoritative "does this column exist?" check via `PRAGMA table_info`.
/// Used by `migrate()` to decide whether to run an `ALTER TABLE ADD COLUMN`.
/// Returns an `Err` only on genuine query failures (bad table name,
/// connection problem) — a missing column returns `Ok(false)`, which the
/// older `SELECT col FROM tbl LIMIT 0` + `.is_ok()` pattern couldn't
/// distinguish from transient lock errors.
fn has_column(conn: &rusqlite::Connection, table: &str, column: &str) -> Result<bool> {
    // PRAGMA table_info doesn't accept bound parameters, so we substitute
    // the table name into the SQL. Validate it as a SQL identifier first
    // so we can't be tricked into emitting arbitrary SQL via a future
    // caller's user-supplied table name. Migrations only ever pass
    // hard-coded table names, but the guard makes the function safe to
    // re-use.
    if !table
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
        || table.is_empty()
    {
        return Err(anyhow::anyhow!("invalid table name: {table}"));
    }
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        // PRAGMA table_info layout: (cid, name, type, notnull, dflt_value, pk).
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// Tests.
//
// Each test opens its own `Database` in a per-test tempdir (via `tempfile`),
// so there's no shared state to coordinate and `cargo test` can run them in
// parallel. Tests cover the migration boot, basic CRUD round-trips, FK
// cascades, and the `query_only` enforcement added in v1.0.1.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Open a fresh database in an ephemeral tempdir and run migrations.
    /// The `TempDir` handle must outlive the `Database`; we return both so
    /// the caller can drop them together at the end of the test.
    fn fresh_db() -> (Database, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("loach.db");
        let db = Database::open(&path).expect("open");
        db.migrate().expect("migrate");
        (db, dir)
    }

    #[test]
    fn open_migrate_is_idempotent() {
        // Running migrate twice on the same file must succeed — the suite
        // uses `CREATE TABLE IF NOT EXISTS` + has_column-gated ALTERs.
        let (db, _dir) = fresh_db();
        db.migrate().expect("second migrate");
        db.migrate().expect("third migrate");
    }

    #[test]
    fn session_crud_roundtrip() {
        let (db, _dir) = fresh_db();
        let s = db
            .create_session("My chat", "ollama", "llama3", Some("be helpful"), None)
            .expect("create");
        let listed = db.list_sessions().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, s.id);
        assert_eq!(listed[0].title, "My chat");
        assert_eq!(listed[0].provider, "ollama");
        assert_eq!(listed[0].model, "llama3");
        assert_eq!(listed[0].system_prompt.as_deref(), Some("be helpful"));

        db.delete_session(&s.id).expect("delete");
        assert!(db.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn deleting_session_cascades_to_messages() {
        let (db, _dir) = fresh_db();
        let s = db
            .create_session("t", "ollama", "llama3", None, None)
            .unwrap();
        db.append_message(&s.id, "user", "hello", None).unwrap();
        db.append_message(&s.id, "assistant", "hi", None).unwrap();
        assert_eq!(db.list_messages(&s.id).unwrap().len(), 2);

        db.delete_session(&s.id).unwrap();
        // ON DELETE CASCADE on `messages.session_id` should have nuked the
        // child rows. A regression here would silently retain orphan messages
        // pinned to nothing — visible only in DB inspection.
        assert!(db.list_messages(&s.id).unwrap().is_empty());
    }

    #[test]
    fn session_message_counts_groups_by_session_and_omits_empty() {
        let (db, _dir) = fresh_db();
        let a = db.create_session("a", "ollama", "llama3", None, None).unwrap();
        let b = db.create_session("b", "ollama", "llama3", None, None).unwrap();
        // `c` stays empty — it must be ABSENT from the map (GROUP BY emits only
        // sessions that have rows). The startup cull relies on a missing key
        // meaning "0 messages"; if this query ever started emitting a 0 row for
        // empty sessions the cull would still work, but the absence is the
        // contract the frontend's `counts[id] ?? 0` is written against.
        let c = db.create_session("c", "ollama", "llama3", None, None).unwrap();

        db.append_message(&a.id, "user", "hi", None).unwrap();
        db.append_message(&a.id, "assistant", "yo", None).unwrap();
        db.append_message(&b.id, "user", "solo", None).unwrap();

        let counts = db.session_message_counts().unwrap();
        assert_eq!(counts.get(&a.id), Some(&2));
        assert_eq!(counts.get(&b.id), Some(&1));
        assert_eq!(counts.get(&c.id), None);
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn space_crud_and_session_link() {
        let (db, _dir) = fresh_db();
        let sp = db.create_space("Work", "stuff", "be concise").unwrap();
        assert_eq!(db.list_spaces().unwrap().len(), 1);

        // A session attached to the space should round-trip the space_id.
        let s = db
            .create_session("t", "ollama", "llama3", None, Some(&sp.id))
            .unwrap();
        let listed = db.list_sessions().unwrap();
        assert_eq!(listed[0].space_id.as_deref(), Some(sp.id.as_str()));

        // Deleting the space sets `sessions.space_id = NULL` (ON DELETE
        // SET NULL); the chat itself survives but is orphaned.
        db.delete_space(&sp.id).unwrap();
        let after = db.list_sessions().unwrap();
        assert_eq!(after.len(), 1, "session must outlive its space");
        assert_eq!(after[0].id, s.id);
        assert!(after[0].space_id.is_none(), "space_id must be cleared");
    }

    #[test]
    fn pool_connection_is_query_only() {
        // The new `PRAGMA query_only=ON` in `with_init` (v1.0.1) means any
        // attempted write through a pooled connection errors at SQLite level.
        // This locks in the safety invariant the comment in `Database` now
        // actually advertises.
        let (db, _dir) = fresh_db();
        // Seed a row through the writer so the table isn't empty when we
        // try the forbidden write.
        db.create_session("t", "ollama", "llama3", None, None)
            .unwrap();

        let err = db
            .with_read(|conn| {
                conn.execute(
                    "UPDATE sessions SET title = 'pwned'",
                    rusqlite::params![],
                )?;
                Ok(())
            })
            .expect_err("write through read pool must fail under query_only=ON");

        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("read") || msg.contains("readonly") || msg.contains("read-only"),
            "expected read-only/readonly error, got: {msg}"
        );

        // Reads through the same pool still work.
        let listed = db
            .with_read(|conn| {
                let mut stmt = conn.prepare("SELECT COUNT(*) FROM sessions")?;
                let n: i64 = stmt.query_row([], |r| r.get(0))?;
                Ok(n)
            })
            .unwrap();
        assert_eq!(listed, 1);
    }

    #[test]
    fn snippet_crud_roundtrip() {
        let (db, _dir) = fresh_db();
        let sn = db
            .create_snippet(
                "Greet",
                "Hi {name}",
                None,
                Some("ollama"),
                Some("llama3"),
            )
            .unwrap();
        let all = db.list_snippets().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, sn.id);
        assert_eq!(all[0].title, "Greet");
        assert_eq!(all[0].provider.as_deref(), Some("ollama"));
    }
}
