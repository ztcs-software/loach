use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub params_json: Option<String>,
    pub space_id: Option<String>,
    pub pinned_at: Option<i64>,
    /// When non-null, the session is archived and hidden from the main chat
    /// list. The value is the ms-timestamp of when it was archived.
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
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
    pub attachments_json: Option<String>,
    /// Optional default provider ("ollama" | "openai") — when set, running the
    /// snippet creates a new chat pre-selected to this provider/model pair.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
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
    pub thinking: Option<String>,
    pub attachments_json: Option<String>,
    pub metrics_json: Option<String>,
    pub created_at: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("open sqlite")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
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

        // Add space_id column to sessions if missing (migration from v1).
        let has_space_id = conn
            .prepare("SELECT space_id FROM sessions LIMIT 0")
            .is_ok();
        if !has_space_id {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL;
                 CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions(space_id);",
            )?;
        }

        // Add pinned_at column to sessions if missing.
        let has_pinned_at = conn
            .prepare("SELECT pinned_at FROM sessions LIMIT 0")
            .is_ok();
        if !has_pinned_at {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;",
            )?;
        }

        // Add thinking column to messages if missing.
        let has_thinking = conn
            .prepare("SELECT thinking FROM messages LIMIT 0")
            .is_ok();
        if !has_thinking {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN thinking TEXT;",
            )?;
        }

        // Add provider + model columns to snippets if missing (for pinning a
        // default model to a snippet).
        let has_snippet_provider = conn
            .prepare("SELECT provider FROM snippets LIMIT 0")
            .is_ok();
        if !has_snippet_provider {
            conn.execute_batch(
                "ALTER TABLE snippets ADD COLUMN provider TEXT;
                 ALTER TABLE snippets ADD COLUMN model TEXT;",
            )?;
        }

        // Add archived_at column to sessions if missing. Null = live chat;
        // otherwise the ms-timestamp the session was archived.
        let has_archived_at = conn
            .prepare("SELECT archived_at FROM sessions LIMIT 0")
            .is_ok();
        if !has_archived_at {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
                 CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at);",
            )?;
        }

        Ok(())
    }

    // ------------ sessions ------------

    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, provider, model, system_prompt, params_json, space_id, pinned_at, archived_at, created_at, updated_at
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
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
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
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, provider, model, system_prompt, params_json, space_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?7)",
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
            created_at: now,
            updated_at: now,
        })
    }

    pub fn rename_session(&self, id: &str, title: &str) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;
        Ok(())
    }

    pub fn update_session_meta(
        &self,
        id: &str,
        provider: Option<&str>,
        model: Option<&str>,
        system_prompt: Option<&str>,
        params_json: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET
                provider = COALESCE(?1, provider),
                model = COALESCE(?2, model),
                system_prompt = ?3,
                params_json = ?4,
                updated_at = ?5
             WHERE id = ?6",
            params![provider, model, system_prompt, params_json, now, id],
        )?;
        Ok(())
    }

    pub fn touch_session(&self, id: &str) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    pub fn pin_session(&self, id: &str, pinned: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let pinned_at: Option<i64> = if pinned {
            Some(Utc::now().timestamp_millis())
        } else {
            None
        };
        conn.execute(
            "UPDATE sessions SET pinned_at = ?1 WHERE id = ?2",
            params![pinned_at, id],
        )?;
        Ok(())
    }

    pub fn archive_session(&self, id: &str, archived: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let archived_at: Option<i64> = if archived {
            Some(Utc::now().timestamp_millis())
        } else {
            None
        };
        // Archiving also clears the pinned flag so an unarchived chat doesn't
        // silently re-appear as a pinned item.
        conn.execute(
            "UPDATE sessions SET archived_at = ?1,
                                 pinned_at = CASE WHEN ?1 IS NULL THEN pinned_at ELSE NULL END
             WHERE id = ?2",
            params![archived_at, id],
        )?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, provider, model, system_prompt, params_json, space_id, pinned_at, archived_at, created_at, updated_at
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
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            }))
        } else {
            Ok(None)
        }
    }

    // ------------ messages ------------

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, thinking, attachments_json, metrics_json, created_at
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
                    created_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
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
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, metrics_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6)",
                params![id, session_id, role, content, attachments_json, now],
            )?;
        }
        self.touch_session(session_id)?;
        Ok(Message {
            id,
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            thinking: None,
            attachments_json: attachments_json.map(|s| s.to_string()),
            metrics_json: None,
            created_at: now,
        })
    }

    pub fn update_message(
        &self,
        id: &str,
        content: &str,
        thinking: Option<&str>,
        metrics_json: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET content = ?1, thinking = ?2, metrics_json = COALESCE(?3, metrics_json) WHERE id = ?4",
            params![content, thinking, metrics_json, id],
        )?;
        Ok(())
    }

    // ------------ settings ------------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(r) = rows.next()? {
            Ok(Some(r.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ------------ spaces ------------

    pub fn list_spaces(&self) -> Result<Vec<Space>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, instructions, created_at, updated_at
             FROM spaces ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Space {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    instructions: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_space(&self, id: &str) -> Result<Option<Space>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, instructions, created_at, updated_at
             FROM spaces WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(Space {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                instructions: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn create_space(
        &self,
        name: &str,
        description: &str,
        instructions: &str,
    ) -> Result<Space> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO spaces (id, name, description, instructions, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, description, instructions, now],
        )?;
        Ok(Space {
            id,
            name: name.to_string(),
            description: description.to_string(),
            instructions: instructions.to_string(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_space(
        &self,
        id: &str,
        name: &str,
        description: &str,
        instructions: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE spaces SET name = ?1, description = ?2, instructions = ?3, updated_at = ?4
             WHERE id = ?5",
            params![name, description, instructions, now, id],
        )?;
        Ok(())
    }

    pub fn delete_space(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM spaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------ space files ------------

    pub fn list_space_files(&self, space_id: &str) -> Result<Vec<SpaceFile>> {
        let conn = self.conn.lock().unwrap();
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
    }

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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM space_files WHERE id = ?1", params![file_id])?;
        Ok(())
    }

    // ------------ snippets ------------

    pub fn list_snippets(&self) -> Result<Vec<Snippet>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE snippets SET title = ?1, prompt = ?2, attachments_json = ?3,
                                 provider = ?4, model = ?5, updated_at = ?6
             WHERE id = ?7",
            params![title, prompt, attachments_json, provider, model, now, id],
        )?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------ mcp servers ------------
    //
    // Only the HTTP transport is supported, so every row has a URL and the
    // legacy stdio-flavoured columns stay NULL.

    pub fn list_mcp_servers(&self) -> Result<Vec<McpServer>> {
        let conn = self.conn.lock().unwrap();
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
    }

    pub fn get_mcp_server(&self, id: &str) -> Result<Option<McpServer>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, url, headers_json, enabled, created_at, updated_at
             FROM mcp_servers WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(McpServer {
                id: r.get(0)?,
                name: r.get(1)?,
                url: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                headers_json: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            }))
        } else {
            Ok(None)
        }
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
        let conn = self.conn.lock().unwrap();

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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, thinking, attachments_json, metrics_json, created_at
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
                    created_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Read every space file across every space.
    pub fn all_space_files(&self) -> Result<Vec<SpaceFile>> {
        let conn = self.conn.lock().unwrap();
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
    pub fn snapshot(&self) -> Result<DatabaseSnapshot> {
        Ok(DatabaseSnapshot {
            schema: "loach/v1".to_string(),
            exported_at: Utc::now().timestamp_millis(),
            loach_version: env!("CARGO_PKG_VERSION").to_string(),
            data: SnapshotData {
                sessions: self.list_sessions()?,
                messages: self.all_messages()?,
                spaces: self.list_spaces()?,
                space_files: self.all_space_files()?,
                snippets: self.list_snippets()?,
                mcp_servers: self.list_mcp_servers()?,
                settings: self.all_settings()?,
            },
        })
    }

    /// Replace the contents of every table with the snapshot. Returns a
    /// row-count breakdown for the UI to display ("Imported 12 chats, 145
    /// messages, …"). FK enforcement is disabled for the duration so a
    /// snapshot that's missing e.g. a referenced space_id for a session
    /// still imports cleanly (the orphan FK becomes NULL at next write).
    pub fn restore_snapshot(&self, snap: &DatabaseSnapshot) -> Result<ImportStats> {
        let mut conn = self.conn.lock().unwrap();

        // PRAGMA foreign_keys cannot be toggled inside a transaction, so
        // flip it before begin and restore after commit.
        conn.pragma_update(None, "foreign_keys", "OFF")?;

        let tx = conn.transaction()?;
        tx.execute_batch(
            r#"
            DELETE FROM messages;
            DELETE FROM space_files;
            DELETE FROM sessions;
            DELETE FROM spaces;
            DELETE FROM snippets;
            DELETE FROM mcp_servers;
            DELETE FROM settings;
            "#,
        )?;

        let d = &snap.data;

        for s in &d.sessions {
            tx.execute(
                "INSERT INTO sessions (id, title, provider, model, system_prompt, params_json,
                                       space_id, pinned_at, archived_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                    s.created_at,
                    s.updated_at,
                ],
            )?;
        }

        for m in &d.messages {
            tx.execute(
                "INSERT INTO messages (id, session_id, role, content, thinking,
                                       attachments_json, metrics_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    m.id,
                    m.session_id,
                    m.role,
                    m.content,
                    m.thinking,
                    m.attachments_json,
                    m.metrics_json,
                    m.created_at,
                ],
            )?;
        }

        for sp in &d.spaces {
            tx.execute(
                "INSERT INTO spaces (id, name, description, instructions, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    sp.id,
                    sp.name,
                    sp.description,
                    sp.instructions,
                    sp.created_at,
                    sp.updated_at,
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
            snippets: d.snippets.len(),
            mcp_servers: d.mcp_servers.len(),
            settings: d.settings.len(),
        };

        tx.commit()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(stats)
    }

    /// Archive every session that isn't already archived. Pinned flags are
    /// cleared for parity with `archive_session`. Returns the number of
    /// rows that were newly archived so the UI can show a toast.
    pub fn archive_all_sessions(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().timestamp_millis();
        let affected = conn.execute(
            "UPDATE sessions SET archived_at = ?1, pinned_at = NULL
             WHERE archived_at IS NULL",
            params![now],
        )?;
        Ok(affected as i64)
    }

    /// Delete everything the user created (chats, spaces, snippets,
    /// MCP servers) while leaving app settings intact. `messages` and
    /// `space_files` fall via ON DELETE CASCADE.
    pub fn wipe_user_data(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            r#"
            DELETE FROM messages;
            DELETE FROM space_files;
            DELETE FROM sessions;
            DELETE FROM spaces;
            DELETE FROM snippets;
            DELETE FROM mcp_servers;
            "#,
        )?;
        tx.commit()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    /// Factory reset: everything `wipe_user_data` does, plus a settings
    /// purge. Caller is responsible for clearing the OS-kept OpenAI key
    /// since that lives outside SQLite.
    pub fn wipe_all(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            r#"
            DELETE FROM messages;
            DELETE FROM space_files;
            DELETE FROM sessions;
            DELETE FROM spaces;
            DELETE FROM snippets;
            DELETE FROM mcp_servers;
            DELETE FROM settings;
            "#,
        )?;
        tx.commit()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
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
    pub snippets: Vec<Snippet>,
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
    pub snippets: usize,
    pub mcp_servers: usize,
    pub settings: usize,
}
