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
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
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

        Ok(())
    }

    // ------------ sessions ------------

    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, provider, model, system_prompt, params_json, space_id, created_at, updated_at
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
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
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

    pub fn delete_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, provider, model, system_prompt, params_json, space_id, created_at, updated_at
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
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            }))
        } else {
            Ok(None)
        }
    }

    // ------------ messages ------------

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, attachments_json, metrics_json, created_at
             FROM messages WHERE session_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id], |r| {
                Ok(Message {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    attachments_json: r.get(4)?,
                    metrics_json: r.get(5)?,
                    created_at: r.get(6)?,
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
                "INSERT INTO messages (id, session_id, role, content, attachments_json, metrics_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
                params![id, session_id, role, content, attachments_json, now],
            )?;
        }
        self.touch_session(session_id)?;
        Ok(Message {
            id,
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            attachments_json: attachments_json.map(|s| s.to_string()),
            metrics_json: None,
            created_at: now,
        })
    }

    pub fn update_message(
        &self,
        id: &str,
        content: &str,
        metrics_json: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET content = ?1, metrics_json = COALESCE(?2, metrics_json) WHERE id = ?3",
            params![content, metrics_json, id],
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
}
