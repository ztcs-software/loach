use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::{
    DatabaseSnapshot, Folder, ImportStats, McpServer, Message, MessageHit, Session, Snippet,
    SnippetFillValue, SnippetVariable, Space, SpaceFile, SpaceMemory, StorageStats,
};
use crate::mcp::{self, McpTestResult};
use crate::providers::{self, ChatRequest, ModelInfo};
use crate::secrets;
use crate::security::{self, LockMethod, LockStatus};
use crate::tools::fetch_url::{self as fetch_url_tool, FetchedPage};
use crate::AppState;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- sessions ----------

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    state.db.list_sessions().map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionArgs {
    pub title: Option<String>,
    pub provider: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub space_id: Option<String>,
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    args: CreateSessionArgs,
) -> Result<Session, String> {
    let title = args.title.unwrap_or_else(|| "New chat".to_string());
    state
        .db
        .create_session(
            &title,
            &args.provider,
            &args.model,
            args.system_prompt.as_deref(),
            args.space_id.as_deref(),
        )
        .map_err(err)
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    state.db.rename_session(&id, &title).map_err(err)
}

#[tauri::command]
pub async fn pin_session(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    state.db.pin_session(&id, pinned).map_err(err)
}

#[tauri::command]
pub async fn archive_session(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> Result<(), String> {
    state.db.archive_session(&id, archived).map_err(err)
}

#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_session(&id).map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct ForkSessionArgs {
    pub source_session_id: String,
    /// When set, the fork stops after this message (inclusive). When None,
    /// every message in the source chat is copied. Matches the two UI entry
    /// points: header "Fork this chat" → None, message kebab "Fork from
    /// here" → Some(message_id).
    #[serde(default)]
    pub up_to_message_id: Option<String>,
}

/// Branch a chat. Returns the newly-created session — the caller is
/// responsible for navigating to it.
#[tauri::command]
pub async fn fork_session(
    state: State<'_, AppState>,
    args: ForkSessionArgs,
) -> Result<Session, String> {
    state
        .db
        .fork_session(&args.source_session_id, args.up_to_message_id.as_deref())
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSessionModelArgs {
    pub id: String,
    pub provider: String,
    pub model: String,
}

/// Persist the (provider, model) pair for a session. Used by the chat
/// header's model dropdown so a swap survives a reload.
#[tauri::command]
pub async fn update_session_model(
    state: State<'_, AppState>,
    args: UpdateSessionModelArgs,
) -> Result<(), String> {
    state
        .db
        .update_session_model(&args.id, &args.provider, &args.model)
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSessionSystemPromptArgs {
    pub id: String,
    pub prompt: String,
}

/// Persist the free-text "Custom instructions" textarea for a session.
#[tauri::command]
pub async fn update_session_system_prompt(
    state: State<'_, AppState>,
    args: UpdateSessionSystemPromptArgs,
) -> Result<(), String> {
    state
        .db
        .update_session_system_prompt(&args.id, &args.prompt)
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSessionParamsArgs {
    pub id: String,
    /// `None` clears the per-session override; `Some(json)` pins the
    /// supplied serialised `GenerationParams` blob.
    #[serde(default)]
    pub params_json: Option<String>,
}

/// Persist the per-session generation-parameter override slider state.
#[tauri::command]
pub async fn update_session_params(
    state: State<'_, AppState>,
    args: UpdateSessionParamsArgs,
) -> Result<(), String> {
    state
        .db
        .update_session_params(&args.id, args.params_json.as_deref())
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSessionLabelArgs {
    pub id: String,
    /// Palette id from `src/lib/labels.ts` (`"red"`, `"blue"`, …). `None`
    /// clears the label. Not validated against the palette here — an id we
    /// don't ship (only reachable via a hand-edited snapshot import) renders
    /// as no label rather than breaking the row.
    #[serde(default)]
    pub label: Option<String>,
}

/// Set or clear the chat's colour label.
#[tauri::command]
pub async fn update_session_label(
    state: State<'_, AppState>,
    args: UpdateSessionLabelArgs,
) -> Result<(), String> {
    state
        .db
        .update_session_label(&args.id, args.label.as_deref())
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct SetSessionFolderArgs {
    pub id: String,
    /// Folder to file the chat under. `None` pulls it back out into the
    /// loose, date-grouped list. Not checked against the folders table —
    /// a dangling id renders as a loose chat rather than breaking the row.
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// Move a chat into a folder, or out of whatever folder it's in.
#[tauri::command]
pub async fn set_session_folder(
    state: State<'_, AppState>,
    args: SetSessionFolderArgs,
) -> Result<(), String> {
    state
        .db
        .set_session_folder(&args.id, args.folder_id.as_deref())
        .map_err(err)
}

// ---------- folders ----------

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    state.db.list_folders().map_err(err)
}

/// Create a folder. The caller (the sidebar's drag-to-group gesture) is
/// responsible for moving chats into it afterwards.
#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, name: String) -> Result<Folder, String> {
    state.db.create_folder(&name).map_err(err)
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state.db.rename_folder(&id, &name).map_err(err)
}

/// Delete a folder. Its chats survive and fall back into the date-grouped
/// list — `sessions.folder_id` is ON DELETE SET NULL.
#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_folder(&id).map_err(err)
}

#[tauri::command]
pub async fn export_session(
    state: State<'_, AppState>,
    id: String,
    format: String,
) -> Result<String, String> {
    let session = state
        .db
        .get_session(&id)
        .map_err(err)?
        .ok_or_else(|| "session not found".to_string())?;
    let messages = state.db.list_messages(&id).map_err(err)?;

    match format.as_str() {
        "json" => {
            let payload = serde_json::json!({
                "session": session,
                "messages": messages,
            });
            serde_json::to_string_pretty(&payload).map_err(err)
        }
        "md" | "markdown" => {
            let mut out = String::new();
            out.push_str(&format!("# {}\n\n", session.title));
            out.push_str(&format!(
                "_Provider: {} · Model: {}_\n\n",
                session.provider, session.model
            ));
            if let Some(sys) = session.system_prompt.as_deref() {
                if !sys.is_empty() {
                    out.push_str("## System prompt\n\n");
                    out.push_str(sys);
                    out.push_str("\n\n");
                }
            }
            for m in &messages {
            // Hidden imported rows are deliberately folded out of the
            // transcript; a user sharing an export shouldn't unknowingly
            // publish context they believe is tucked away.
            if m.import_hidden {
                continue;
            }
                let role = match m.role.as_str() {
                    "user" => "You",
                    "assistant" => "Assistant",
                    _ => "System",
                };
                out.push_str(&format!("## {role}\n\n{}\n\n", m.content));
            }
            Ok(out)
        }
        _ => Err(format!("unsupported format: {format}")),
    }
}

// ---------- messages ----------

/// The only roles the `messages.role` column is documented to hold
/// (`db.rs`). The streaming path only ever appends `"user"` / `"assistant"`,
/// but `append_message` / `import_messages` take the role as a free string —
/// without this guard a crafted import (or a buggy frontend) could store an
/// arbitrary role that the chat-history builder then forwards to the
/// provider as a turn, surfacing as a confusing upstream 400 rather than a
/// clear validation error.
fn validate_role(role: &str) -> Result<(), String> {
    match role {
        "user" | "assistant" | "system" => Ok(()),
        other => Err(format!(
            "invalid message role `{other}` (expected user, assistant, or system)"
        )),
    }
}

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Message>, String> {
    state.db.list_messages(&session_id).map_err(err)
}

/// Per-session message counts (`{ session_id: count }`). Lets the frontend
/// cull empty sessions at startup without loading every transcript over IPC.
#[tauri::command]
pub async fn session_message_counts(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, i64>, String> {
    state.db.session_message_counts().map_err(err)
}

/// Hard ceiling on `search_messages` results, whatever the caller asks for.
/// The palette shows a handful; this only stops a bug (or a future caller)
/// from turning the search box into a whole-database export.
const MAX_MESSAGE_HITS: usize = 50;

/// Substring search across live chat transcripts, backing the Cmd-K palette's
/// message results. See `Database::search_messages` for what's in scope.
#[tauri::command]
pub async fn search_messages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MessageHit>, String> {
    let limit = limit.unwrap_or(20).min(MAX_MESSAGE_HITS);
    state.db.search_messages(&query, limit).map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct AppendMessageArgs {
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub attachments_json: Option<String>,
}

#[tauri::command]
pub async fn append_message(
    state: State<'_, AppState>,
    args: AppendMessageArgs,
) -> Result<Message, String> {
    validate_role(&args.role)?;
    state
        .db
        .append_message(
            &args.session_id,
            &args.role,
            &args.content,
            args.attachments_json.as_deref(),
        )
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct ImportedMessageIn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportMessagesArgs {
    pub session_id: String,
    pub messages: Vec<ImportedMessageIn>,
    /// `true` = fold the imported batch out of the transcript (it still
    /// reaches the model). See `Database::import_messages`.
    pub hidden: bool,
}

/// Insert a batch of imported messages as one group. Returns the created
/// rows so the frontend can splice them into the transcript without a
/// re-fetch.
#[tauri::command]
pub async fn import_messages(
    state: State<'_, AppState>,
    args: ImportMessagesArgs,
) -> Result<Vec<Message>, String> {
    // Reject the whole batch up front if any row carries an unexpected role,
    // before any DB write — the import dialog only ever produces user /
    // assistant / system, so a bad role here means a malformed payload.
    for m in &args.messages {
        validate_role(&m.role)?;
    }
    let items: Vec<(String, String)> = args
        .messages
        .into_iter()
        .map(|m| (m.role, m.content))
        .collect();
    state
        .db
        .import_messages(&args.session_id, &items, args.hidden)
        .map_err(err)
}

/// Delete an imported batch as a unit, addressed by its group id. Scoped by
/// `session_id` for defense-in-depth (see `Database::delete_import_group`).
#[tauri::command]
pub async fn delete_import_group(
    state: State<'_, AppState>,
    session_id: String,
    group: String,
) -> Result<(), String> {
    state
        .db
        .delete_import_group(&session_id, &group)
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateMessageArgs {
    pub id: String,
    /// The session this message is expected to belong to. The DB layer
    /// rejects the update if the row's `session_id` doesn't match — see
    /// the defense-in-depth note on `Database::update_message`.
    pub session_id: String,
    pub content: String,
    pub thinking: Option<String>,
    pub metrics_json: Option<String>,
    /// JSON-encoded `ToolCallRecord[]` — the MCP tool calls + results made
    /// during this assistant turn. None preserves whatever's already on the
    /// row (so a content-only flush during streaming doesn't clobber
    /// tool calls that landed in a separate write).
    #[serde(default)]
    pub tool_calls_json: Option<String>,
    /// JSON-encoded `Attachment[]` — files produced by built-in tools
    /// during this assistant turn (today only `pdf`). Same COALESCE
    /// semantics as `tool_calls_json`.
    #[serde(default)]
    pub attachments_json: Option<String>,
}

#[tauri::command]
pub async fn update_message(
    state: State<'_, AppState>,
    args: UpdateMessageArgs,
) -> Result<(), String> {
    state
        .db
        .update_message(
            &args.id,
            &args.session_id,
            &args.content,
            args.thinking.as_deref(),
            args.metrics_json.as_deref(),
            args.tool_calls_json.as_deref(),
            args.attachments_json.as_deref(),
        )
        .map_err(err)
}

#[tauri::command]
pub async fn delete_message(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
) -> Result<(), String> {
    state.db.delete_message(&id, &session_id).map_err(err)
}

/// Pin or unpin one assistant response. Pinned rows are listed in the bar
/// under the chat header so the user can jump back to them. Display only —
/// pinning doesn't change what reaches the model.
#[tauri::command]
pub async fn pin_message(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    state.db.pin_message(&id, &session_id, pinned).map_err(err)
}

#[tauri::command]
pub async fn clear_session_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.db.clear_session_messages(&session_id).map_err(err)
}

/// Mark a batch of messages as "rolled into the auto-summary": the rows
/// stay in the DB and keep rendering in the transcript, but the chat
/// history builder skips them so the model only consumes the summary
/// block (in `session.system_prompt`) plus the trailing uncompacted
/// turns. Replaces the older flow where the Compact button hard-deleted
/// the summarised messages — which lost user-visible history forever.
#[tauri::command]
pub async fn mark_messages_compacted(
    state: State<'_, AppState>,
    session_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    state
        .db
        .mark_messages_compacted(&session_id, &ids)
        .map_err(err)
}

// ---------- settings ----------

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let rows = state.db.all_settings().map_err(err)?;
    Ok(rows.into_iter().collect())
}

/// Settings keys the renderer is allowed to write. Mirrors the
/// `DEFAULT_SETTINGS` map in `src/types.ts` — keep them in lockstep when
/// adding a new user-facing setting.
///
/// The allowlist is a defence against a compromised renderer planting
/// arbitrary KV rows. The concrete attack it closes: silently repointing
/// `openai_base_url` at an attacker host so the stored bearer token gets
/// shipped on the next chat request. With this gate in place, the only
/// way to write a setting from the UI is to use a known key — a future
/// settings consumer that forgets its own validation can't be exploited
/// via a key the renderer was free to mint. Unknown keys fail loudly so
/// a stale frontend with a typo errors instead of silently dropping the
/// write.
const WRITABLE_SETTING_KEYS: &[&str] = &[
    "theme",
    "background_style",
    "font_size",
    "ollama_base_url",
    "ollama_auto_launch",
    "openai_base_url",
    "global_system_prompt",
    "default_provider",
    "default_model",
    "default_model_choice",
    "default_model_preload",
    "user_name",
    "temporal_awareness",
    "web_fetch_enabled",
    "low_vram_global",
    "ollama_keep_alive",
    "thinking_default",
    "default_tone_id",
    "onboarding_completed",
    "auto_check_updates",
    "lock_idle_timeout",
    "lock_on_hide",
    "recent_commands",
];

/// Whether `key` is a setting the app is allowed to write. Built-in tool
/// toggles (`*_tool_enabled`) live in the registry at
/// [`crate::tools::builtin`] so a new tool is a one-line registry edit
/// instead of a separate allowlist update; everything else must match the
/// static `WRITABLE_SETTING_KEYS` exactly. Shared by `set_setting` and the
/// snapshot-import path so both enforce the same boundary.
fn is_writable_setting_key(key: &str) -> bool {
    WRITABLE_SETTING_KEYS.contains(&key)
        || crate::tools::builtin::setting_keys().any(|k| k == key)
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    if !is_writable_setting_key(&key) {
        return Err(format!(
            "setting `{key}` is not on the writable allowlist"
        ));
    }
    state.db.set_setting(&key, &value).map_err(err)
}

#[tauri::command]
pub async fn set_openai_key(key: String) -> Result<(), String> {
    // Keyring calls block on the OS credential store — on Linux that's
    // a DBus round-trip to the Secret Service which can stall for
    // hundreds of ms if `gnome-keyring-daemon` is unlocking a profile or
    // the user is on a slow Polkit prompt. Don't run that on the tokio
    // runtime; offload to the blocking pool.
    tokio::task::spawn_blocking(move || secrets::set_openai_key(&key))
        .await
        .map_err(|e| format!("set_openai_key task panicked: {e}"))?
        .map_err(err)
}

#[tauri::command]
pub async fn get_openai_key_status() -> Result<bool, String> {
    tokio::task::spawn_blocking(secrets::has_openai_key)
        .await
        .map_err(|e| format!("get_openai_key_status task panicked: {e}"))
}

#[tauri::command]
pub async fn clear_openai_key() -> Result<(), String> {
    tokio::task::spawn_blocking(secrets::clear_openai_key)
        .await
        .map_err(|e| format!("clear_openai_key task panicked: {e}"))?
        .map_err(err)
}

// ---------- security (app lock) ----------

#[tauri::command]
pub async fn security_status() -> Result<LockStatus, String> {
    // `security::status` itself is cheap, but every other security command
    // calls argon2 which is intentionally CPU-expensive (~50–100 ms at the
    // default params). Run them on the blocking pool so the tokio runtime
    // worker that picked up the IPC call isn't parked for the duration —
    // otherwise a slow unlock attempt can stall every other in-flight
    // command, including the UI's own event listeners.
    tokio::task::spawn_blocking(security::status)
        .await
        .map_err(|e| format!("security_status task panicked: {e}"))?
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct SecuritySetupArgs {
    pub method: LockMethod,
    pub pin: Option<String>,
    pub password: Option<String>,
    pub pin_length: Option<u8>,
    pub hint: Option<String>,
    /// When a lock is already configured, the renderer MUST supply the
    /// current credentials so the backend can verify the user before
    /// overwriting the keyring entry. Ignored when no lock is configured.
    #[serde(default)]
    pub current_pin: Option<String>,
    #[serde(default)]
    pub current_password: Option<String>,
}

#[tauri::command]
pub async fn security_setup(args: SecuritySetupArgs) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        security::setup(
            args.method,
            args.pin.as_deref(),
            args.password.as_deref(),
            args.pin_length,
            args.hint,
            args.current_pin.as_deref(),
            args.current_password.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("security_setup task panicked: {e}"))?
    .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct SecurityUnlockArgs {
    pub pin: Option<String>,
    pub password: Option<String>,
}

#[tauri::command]
pub async fn security_unlock(args: SecurityUnlockArgs) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        security::unlock(args.pin.as_deref(), args.password.as_deref())
    })
    .await
    .map_err(|e| format!("security_unlock task panicked: {e}"))?
    .map_err(err)
}

#[tauri::command]
pub async fn security_get_hint() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(security::get_hint)
        .await
        .map_err(|e| format!("security_get_hint task panicked: {e}"))?
        .map_err(err)
}

#[derive(Debug, Deserialize, Default)]
pub struct SecurityClearArgs {
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Remove the configured app lock. Renderer must pass the user's current
/// credentials — otherwise a compromised UI could disable the lock without
/// any prompt. The internal `factory_reset` path uses `security::clear`
/// directly because it has its own destructive-action gate.
#[tauri::command]
pub async fn security_clear(args: Option<SecurityClearArgs>) -> Result<(), String> {
    let args = args.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        security::clear_with_credentials(args.pin.as_deref(), args.password.as_deref())
    })
    .await
    .map_err(|e| format!("security_clear task panicked: {e}"))?
    .map_err(err)
}

// ---------- host hardware ----------

/// Coarse machine capacity, read once by onboarding so the Ollama catalog can
/// size its recommendation against the host instead of quoting raw gigabytes.
#[derive(Debug, Serialize)]
pub struct SystemInfo {
    /// Physical RAM installed, in bytes.
    pub total_ram_bytes: u64,
    /// RAM not currently in use, in bytes. Advisory only — the OS will evict
    /// cache under pressure, so a model larger than this may still run.
    pub available_ram_bytes: u64,
    /// Free space on the volume holding the app data directory, in bytes, or
    /// `null` when no mounted disk contains that path (network shares, some
    /// container mounts). Callers must treat null as "unknown", not "full".
    pub free_disk_bytes: Option<u64>,
    /// Dedicated VRAM of the most capable discrete GPU, in bytes, or `null`
    /// when there isn't one we can read. This is the figure that actually
    /// decides whether a model runs fast: Ollama offloads whatever doesn't fit
    /// to the CPU. Null on macOS by design — unified memory means
    /// `total_ram_bytes` already describes the GPU's budget.
    pub vram_bytes: Option<u64>,
    /// Adapter name for display, e.g. "NVIDIA GeForce RTX 4060". Null
    /// whenever `vram_bytes` is.
    pub gpu_name: Option<String>,
}

/// Probe installed RAM, free disk, and discrete-GPU VRAM. Cheap enough to call
/// on demand, but onboarding only asks once per mount.
#[tauri::command]
pub async fn system_info(app: AppHandle) -> Result<SystemInfo, String> {
    use tauri::Manager;

    let data_dir = app.path().app_data_dir().map_err(err)?;

    tokio::task::spawn_blocking(move || {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();

        // Pick the mounted disk whose mount point is the longest prefix of the
        // app data dir — on Unix every path is under `/`, so the deepest match
        // is the volume actually holding it rather than the root filesystem.
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let free_disk_bytes = disks
            .iter()
            .filter(|d| data_dir.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| d.available_space());

        let gpu = crate::gpu::detect();

        SystemInfo {
            total_ram_bytes: sys.total_memory(),
            available_ram_bytes: sys.available_memory(),
            free_disk_bytes,
            vram_bytes: gpu.as_ref().map(|g| g.vram_bytes),
            gpu_name: gpu.map(|g| g.name),
        }
    })
    .await
    .map_err(|e| format!("system_info task panicked: {e}"))
}

// ---------- providers ----------

#[tauri::command]
pub async fn ollama_probe(state: State<'_, AppState>, base_url: String) -> Result<bool, String> {
    Ok(providers::ollama::probe(&state.http, &base_url).await)
}

/// Make sure a local Ollama is running, launching `ollama serve` if it
/// isn't. Resolves once the server answers; the error string is written to
/// be shown to the user verbatim.
#[tauri::command]
pub async fn ollama_start(state: State<'_, AppState>, base_url: String) -> Result<(), String> {
    crate::ollama_launch::start(&state.http, &base_url).await
}

#[tauri::command]
pub async fn ollama_list_models(
    state: State<'_, AppState>,
    base_url: String,
) -> Result<Vec<ModelInfo>, String> {
    providers::ollama::list_models(&state.http, &base_url)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ollama_unload_model(
    state: State<'_, AppState>,
    base_url: String,
    model: String,
) -> Result<(), String> {
    providers::ollama::unload_model(&state.http, &base_url, &model)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ollama_preload_model(
    state: State<'_, AppState>,
    base_url: String,
    model: String,
    num_ctx: Option<u32>,
    low_vram: Option<bool>,
    num_gpu: Option<u32>,
) -> Result<(), String> {
    let keep_alive = state
        .db
        .get_setting("ollama_keep_alive")
        .ok()
        .flatten()
        .as_deref()
        .and_then(providers::ollama::keep_alive_value);
    let options = providers::ollama::preload_options(num_ctx, low_vram, num_gpu);
    providers::ollama::preload_model(&state.http, &base_url, &model, keep_alive, options)
        .await
        .map_err(err)
}

// ------------ ollama model admin ------------
//
// Everything below is used by the Models panel: inspect a model, delete it,
// duplicate it, pull a new one from the registry, or create a derived model
// with a customized Modelfile (system prompt / template / parameters).
//
// Create & pull stream progress frames on the `admin://{stream_id}` channel
// using the same StreamRegistry as chat so cancellation is uniform.

#[tauri::command]
pub async fn ollama_show_model(
    state: State<'_, AppState>,
    base_url: String,
    name: String,
) -> Result<providers::ollama::OllamaShowResponse, String> {
    providers::ollama::show_model(&state.http, &base_url, &name)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ollama_delete_model(
    state: State<'_, AppState>,
    base_url: String,
    name: String,
) -> Result<(), String> {
    providers::ollama::delete_model(&state.http, &base_url, &name)
        .await
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct OllamaCopyArgs {
    pub base_url: String,
    pub source: String,
    pub destination: String,
}

#[tauri::command]
pub async fn ollama_copy_model(
    state: State<'_, AppState>,
    args: OllamaCopyArgs,
) -> Result<(), String> {
    providers::ollama::copy_model(&state.http, &args.base_url, &args.source, &args.destination)
        .await
        .map_err(err)
}

/// Require the caller to have named the event channel, rather than minting an
/// id when they didn't.
///
/// Frames start emitting before the invoke returns, so an id invented here
/// would be announced too late for the caller to `listen()` on — they'd
/// silently lose the head of the stream. Every caller supplies one; this turns
/// the never-hit fallback into a loud error instead of a partial stream.
fn require_stream_id(id: String) -> Result<String, String> {
    if id.trim().is_empty() {
        return Err("stream_id is required — the caller must name the event channel".to_string());
    }
    Ok(id)
}

#[derive(Debug, Deserialize)]
pub struct OllamaPullArgs {
    pub base_url: String,
    pub name: String,
    /// Frontend-supplied stream id so the UI can `listen()` on
    /// `admin://{stream_id}` before the task emits its first frame.
    pub stream_id: String,
}

#[tauri::command]
pub async fn ollama_pull_model(
    app: AppHandle,
    state: State<'_, AppState>,
    args: OllamaPullArgs,
) -> Result<StreamHandle, String> {
    let stream_id = require_stream_id(args.stream_id)?;
    let http = state.http.clone();
    let registry = state.streams.clone();
    let sid = stream_id.clone();
    // Register the cancel Notify SYNCHRONOUSLY, before spawning — same
    // reasoning as `chat_stream`. Registering inside the worker meant an
    // `admin_cancel` arriving during task scheduling or the pre-flight DNS
    // resolution hit an empty registry and was silently discarded, leaving
    // the pull running with no way to stop it.
    let cancel = registry.register(sid.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = providers::ollama::pull_model(
            app,
            http,
            registry,
            &args.base_url,
            &args.name,
            sid,
            cancel,
        )
        .await
        {
            tracing::warn!("ollama pull ended with error: {e:?}");
        }
    });
    Ok(StreamHandle { stream_id })
}

#[derive(Debug, Deserialize)]
pub struct OllamaCreateArgs {
    pub base_url: String,
    pub name: String,
    pub modelfile: String,
    pub stream_id: String,
}

#[tauri::command]
pub async fn ollama_create_model(
    app: AppHandle,
    state: State<'_, AppState>,
    args: OllamaCreateArgs,
) -> Result<StreamHandle, String> {
    let stream_id = require_stream_id(args.stream_id)?;
    let http = state.http.clone();
    let registry = state.streams.clone();
    let sid = stream_id.clone();
    // Registered before the spawn for the same reason as `ollama_pull_model`.
    let cancel = registry.register(sid.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = providers::ollama::create_model(
            app,
            http,
            registry,
            &args.base_url,
            &args.name,
            &args.modelfile,
            sid,
            cancel,
        )
        .await
        {
            tracing::warn!("ollama create ended with error: {e:?}");
        }
    });
    Ok(StreamHandle { stream_id })
}

/// Cancel an in-flight admin stream (pull / create). Same registry as chat,
/// but a named-aliased command so the frontend's intent is obvious.
#[tauri::command]
pub async fn admin_cancel(state: State<'_, AppState>, stream_id: String) -> Result<(), String> {
    state.streams.cancel(&stream_id);
    Ok(())
}

#[tauri::command]
pub async fn openai_list_models(
    state: State<'_, AppState>,
    base_url: String,
) -> Result<Vec<ModelInfo>, String> {
    providers::openai::list_models(&state.http, &base_url)
        .await
        .map_err(err)
}

// ---------- spaces ----------

#[tauri::command]
pub async fn list_spaces(state: State<'_, AppState>) -> Result<Vec<Space>, String> {
    state.db.list_spaces().map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct CreateSpaceArgs {
    pub name: String,
    pub description: Option<String>,
    pub instructions: Option<String>,
}

#[tauri::command]
pub async fn create_space(
    state: State<'_, AppState>,
    args: CreateSpaceArgs,
) -> Result<Space, String> {
    state
        .db
        .create_space(
            &args.name,
            args.description.as_deref().unwrap_or(""),
            args.instructions.as_deref().unwrap_or(""),
        )
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSpaceArgs {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    /// Null in any of these three fields means "inherit from General
    /// Settings" — the frontend treats them as a tri-state. Keeping the
    /// JSON encoding is the simplest way to round-trip through the
    /// settings KV table without bespoke serialisation.
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_params_json: Option<String>,
    /// `Some(true|false)` writes the new value, `None` leaves the existing
    /// row alone. Modelled this way so partial updates from the frontend
    /// (which currently send every other field on every call) don't have to
    /// know about the memory toggle unless they're touching it.
    #[serde(default)]
    pub memory_enabled: Option<bool>,
}

#[tauri::command]
pub async fn update_space(
    state: State<'_, AppState>,
    args: UpdateSpaceArgs,
) -> Result<(), String> {
    state
        .db
        .update_space(
            &args.id,
            &args.name,
            &args.description,
            &args.instructions,
            args.default_provider.as_deref(),
            args.default_model.as_deref(),
            args.default_params_json.as_deref(),
            args.memory_enabled,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn delete_space(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_space(&id).map_err(err)
}

#[tauri::command]
pub async fn list_space_files(
    state: State<'_, AppState>,
    space_id: String,
) -> Result<Vec<SpaceFile>, String> {
    state.db.list_space_files(&space_id).map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct AddSpaceFileArgs {
    pub space_id: String,
    pub name: String,
    pub mime: String,
    pub kind: String,
    pub data: String,
    pub size: i64,
    pub position: i32,
}

#[tauri::command]
pub async fn add_space_file(
    state: State<'_, AppState>,
    args: AddSpaceFileArgs,
) -> Result<SpaceFile, String> {
    state
        .db
        .add_space_file(
            &args.space_id,
            &args.name,
            &args.mime,
            &args.kind,
            &args.data,
            args.size,
            args.position,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn remove_space_file(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<(), String> {
    state.db.remove_space_file(&file_id).map_err(err)
}

#[derive(Debug, Serialize)]
pub struct SpaceContext {
    pub space: Space,
    pub files: Vec<SpaceFile>,
    /// Saved facts auto-extracted (or hand-edited) for this space. Empty
    /// when the space's `memory_enabled` flag is false OR no memories have
    /// accumulated yet — callers don't need to special-case the two: the
    /// system-prompt builder skips an empty list and a disabled memory
    /// space won't have any rows to begin with.
    pub memories: Vec<SpaceMemory>,
}

#[tauri::command]
pub async fn get_space_context(
    state: State<'_, AppState>,
    space_id: String,
) -> Result<SpaceContext, String> {
    let space = state
        .db
        .get_space(&space_id)
        .map_err(err)?
        .ok_or_else(|| "space not found".to_string())?;
    let files = state.db.list_space_files(&space_id).map_err(err)?;
    // Disabled memory still loads zero rows — the toggle gates writes, not
    // reads. Pre-toggle memories stay readable so flipping it off doesn't
    // silently strip context the user might still want.
    let memories = state.db.list_space_memories(&space_id).map_err(err)?;
    Ok(SpaceContext { space, files, memories })
}

// ---------- space memories ----------

#[tauri::command]
pub async fn list_space_memories(
    state: State<'_, AppState>,
    space_id: String,
) -> Result<Vec<SpaceMemory>, String> {
    state.db.list_space_memories(&space_id).map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct AddSpaceMemoryArgs {
    pub space_id: String,
    pub content: String,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_message_id: Option<String>,
}

#[tauri::command]
pub async fn add_space_memory(
    state: State<'_, AppState>,
    args: AddSpaceMemoryArgs,
) -> Result<SpaceMemory, String> {
    let trimmed = args.content.trim();
    if trimmed.is_empty() {
        return Err("memory content is required".into());
    }
    state
        .db
        .add_space_memory(
            &args.space_id,
            trimmed,
            args.source_session_id.as_deref(),
            args.source_message_id.as_deref(),
        )
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSpaceMemoryArgs {
    pub id: String,
    /// Scope check — see the note on `Database::update_space_memory`.
    pub space_id: String,
    pub content: String,
}

#[tauri::command]
pub async fn update_space_memory(
    state: State<'_, AppState>,
    args: UpdateSpaceMemoryArgs,
) -> Result<(), String> {
    state
        .db
        .update_space_memory(&args.id, &args.space_id, args.content.trim())
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct RemoveSpaceMemoryArgs {
    pub id: String,
    pub space_id: String,
}

#[tauri::command]
pub async fn remove_space_memory(
    state: State<'_, AppState>,
    args: RemoveSpaceMemoryArgs,
) -> Result<(), String> {
    state
        .db
        .remove_space_memory(&args.id, &args.space_id)
        .map_err(err)
}

// ---------- snippets ----------

#[tauri::command]
pub async fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    state.db.list_snippets().map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct CreateSnippetArgs {
    pub title: String,
    pub prompt: String,
    pub attachments_json: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn create_snippet(
    state: State<'_, AppState>,
    args: CreateSnippetArgs,
) -> Result<Snippet, String> {
    state
        .db
        .create_snippet(
            &args.title,
            &args.prompt,
            args.attachments_json.as_deref(),
            args.provider.as_deref(),
            args.model.as_deref(),
        )
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSnippetArgs {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub attachments_json: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn update_snippet(
    state: State<'_, AppState>,
    args: UpdateSnippetArgs,
) -> Result<(), String> {
    state
        .db
        .update_snippet(
            &args.id,
            &args.title,
            &args.prompt,
            args.attachments_json.as_deref(),
            args.provider.as_deref(),
            args.model.as_deref(),
        )
        .map_err(err)
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_snippet(&id).map_err(err)
}

// ---------- snippet variables ----------

/// Reserved variable names. These collide with built-in substitutions
/// (`{{USER_NAME}}` set from Settings + `{{CURRENT_*}}` from `temporal.ts`)
/// and would silently shadow them if a user redefined the same key, so the
/// command layer rejects them. The frontend duplicates the list for inline
/// validation, but the server-side check is the source of truth.
const RESERVED_VAR_KEYS: &[&str] = &[
    "USER_NAME",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_WEEKDAY",
    "CURRENT_DATETIME",
    "CURRENT_TIMEZONE",
];

/// Validate a variable key: uppercase letters / digits / underscore, must
/// start with a letter or underscore (no leading digit), 1-64 chars, and
/// not a reserved built-in. Returns the normalised key (already-uppercase
/// passes through unchanged) so callers can rely on a canonical form
/// reaching the DB.
fn normalise_var_key(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("Variable key cannot be empty".to_string());
    }
    if trimmed.len() > 64 {
        return Err("Variable key is too long (max 64 chars)".to_string());
    }
    let upper = trimmed.to_ascii_uppercase();
    let mut chars = upper.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(
            "Variable key must start with a letter or underscore".to_string(),
        );
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!(
                "Variable key contains invalid character '{c}'. Use A-Z, 0-9, or _."
            ));
        }
    }
    if RESERVED_VAR_KEYS.iter().any(|r| *r == upper.as_str()) {
        return Err(format!(
            "'{upper}' is reserved by Loach — pick a different name."
        ));
    }
    Ok(upper)
}

#[tauri::command]
pub async fn list_snippet_variables(
    state: State<'_, AppState>,
) -> Result<Vec<SnippetVariable>, String> {
    state.db.list_snippet_variables().map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct CreateSnippetVariableArgs {
    pub key: String,
    pub value: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn create_snippet_variable(
    state: State<'_, AppState>,
    args: CreateSnippetVariableArgs,
) -> Result<SnippetVariable, String> {
    let key = normalise_var_key(&args.key)?;
    state
        .db
        .create_snippet_variable(&key, &args.value, args.description.as_deref())
        .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpdateSnippetVariableArgs {
    pub id: String,
    pub key: String,
    pub value: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn update_snippet_variable(
    state: State<'_, AppState>,
    args: UpdateSnippetVariableArgs,
) -> Result<(), String> {
    let key = normalise_var_key(&args.key)?;
    state
        .db
        .update_snippet_variable(&args.id, &key, &args.value, args.description.as_deref())
        .map_err(err)
}

#[tauri::command]
pub async fn delete_snippet_variable(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.delete_snippet_variable(&id).map_err(err)
}

#[tauri::command]
pub async fn list_snippet_fill_values(
    state: State<'_, AppState>,
    snippet_id: String,
) -> Result<Vec<SnippetFillValue>, String> {
    state.db.list_snippet_fill_values(&snippet_id).map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct UpsertSnippetFillValuesArgs {
    pub snippet_id: String,
    /// Flat `(key, value)` pairs. The frontend sends every placeholder the
    /// user just filled, including ones whose value didn't change — the
    /// upsert path is idempotent so over-sending is harmless.
    pub values: Vec<(String, String)>,
}

#[tauri::command]
pub async fn upsert_snippet_fill_values(
    state: State<'_, AppState>,
    args: UpsertSnippetFillValuesArgs,
) -> Result<(), String> {
    state
        .db
        .upsert_snippet_fill_values(&args.snippet_id, &args.values)
        .map_err(err)
}

// ---------- mcp servers ----------

/// Input for `mcp_save`. Matches the frontend `McpServerInput` shape: `id`
/// is optional (undefined → insert, set → update). Loach only speaks the
/// Streamable-HTTP transport, so the only connection fields are `url` and
/// the optional `headers` k/v map (stored JSON-encoded to dodge a child
/// table).
#[derive(Debug, Deserialize)]
pub struct McpServerInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl McpServerInput {
    /// Build an ephemeral `McpServer` (no DB id / timestamps) for use with
    /// the test command when we want to dry-run a config before saving.
    fn to_draft(&self) -> McpServer {
        McpServer {
            id: self.id.clone().unwrap_or_default(),
            name: self.name.clone(),
            url: self.url.clone(),
            headers_json: self
                .headers
                .as_ref()
                .map(|m| serde_json::to_string(m).unwrap_or_default()),
            enabled: self.enabled.unwrap_or(true),
            created_at: 0,
            updated_at: 0,
        }
    }
}

/// Render an upstream error string safe to splice into a chat-bubble
/// notice. Collapses whitespace / control chars to single spaces and
/// truncates on a char boundary so a misbehaving server can't:
///   - inject newlines that break the surrounding markdown wrap
///   - bloat the message body with a multi-KB stack trace
///   - silently smuggle echoed `Authorization` headers (or anything
///     similarly shaped) into the persisted transcript, which would
///     then land in snapshots / shared exports.
/// The operator-facing tracing log keeps the unredacted text — only the
/// renderer-visible notice is clipped.
fn sanitize_chat_error(s: &str) -> String {
    const MAX_CHARS: usize = 120;
    let collapsed: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() <= MAX_CHARS {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(MAX_CHARS).collect();
    format!("{cut}…")
}

/// Header-name syntax: RFC 7230 token = 1*tchar, with `tchar` being
/// alphanumerics and a small set of punctuation. We accept the same set so a
/// pasted header name like `Authorization` or `X-API-Key` rolls through but
/// embedded CR / LF / spaces (which would let an attacker smuggle additional
/// headers into the HTTP request) are rejected.
fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '!' | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '-'
                        | '.'
                        | '^'
                        | '_'
                        | '`'
                        | '|'
                        | '~'
                )
        })
}

/// Header-value syntax: any visible ASCII / tab / space. Notably no CR or LF
/// — those would let a value break out of its header and inject a new one.
fn is_valid_header_value(value: &str) -> bool {
    value
        .chars()
        .all(|c| c == '\t' || (' '..='~').contains(&c))
        && value.len() <= 4096
}

/// Validate an MCP server input and return the resolved, SSRF-screened
/// SocketAddrs for its host. The addresses are used by `mcp_test` to build
/// a DNS-pinned reqwest client so the connect-time resolver can't bypass
/// the screen with DNS rebinding. `mcp_save` discards them.
///
/// Async because hostnames have to be DNS-resolved before screening — the
/// previous version only checked literal IPs, so `evil.example.com` →
/// `10.0.0.1` slipped through and the request was sent against the
/// internal address with whatever auth headers the user configured.
/// Why a server row failed validation. Everything except an unanswerable
/// DNS query is a `Rejected`; the split exists so snapshot import can keep a
/// backup that merely references an unreachable host (see stage 2 of
/// `import_data_with_dialog`) while still refusing a tampered one.
/// `Display` — and the `From` below, which keeps `?` working in the
/// `Result<_, String>` commands — reproduce the original messages verbatim.
#[derive(Debug)]
pub(crate) enum McpImportRejection {
    Rejected(String),
    Unscreenable(String),
}

impl std::fmt::Display for McpImportRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(m) | Self::Unscreenable(m) => f.write_str(m),
        }
    }
}

impl From<McpImportRejection> for String {
    fn from(e: McpImportRejection) -> Self {
        e.to_string()
    }
}

async fn validate_mcp_input(
    input: &McpServerInput,
) -> Result<Vec<std::net::SocketAddr>, McpImportRejection> {
    use McpImportRejection::{Rejected, Unscreenable};
    if input.name.trim().is_empty() {
        return Err(Rejected("server name is required".into()));
    }
    let raw_url = input.url.trim();
    if raw_url.is_empty() {
        return Err(Rejected("server URL is required".into()));
    }

    // Scheme + host validation. We refuse anything that isn't http/https and
    // anything that resolves to a link-local address (the cloud-metadata
    // range). Loopback and private / RFC1918 LAN addresses are allowed: MCP
    // servers are user-configured in Settings and are often self-hosted on the
    // local network, matching how the LLM-provider path treats endpoints. A
    // header smuggled in by a compromised renderer still can't be aimed at the
    // cloud-metadata service.
    let parsed = reqwest::Url::parse(raw_url)
        .map_err(|e| Rejected(format!("Invalid MCP server URL: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(Rejected(format!(
                "MCP server URL must be http or https (got `{other}`)"
            )))
        }
    }

    // Resolve + screen the host: literal IPs are rejected only if link-local,
    // hostnames are DNS-resolved and every returned address screened the same
    // way. Returning the addresses lets the caller pin them into a per-request
    // client at connect time so a malicious DNS server can't flip the answer
    // from public to link-local between validate and dial.
    let resolved = crate::tools::fetch_url::resolve_lan_addrs(&parsed)
        .await
        .map_err(|e| {
            let msg = format!("MCP server URL rejected: {e}");
            match e {
                // DNS didn't answer, so the host was never actually screened.
                crate::tools::fetch_url::HostScreenError::Unresolvable(_) => Unscreenable(msg),
                _ => Rejected(msg),
            }
        })?;

    // Header k/v validation. We do NOT call out to the network here, so the
    // only protection we can offer is structural: reject names / values
    // that would let an attacker smuggle CRLF-injected headers via a
    // crafted save call.
    if let Some(headers) = input.headers.as_ref() {
        const MAX_HEADERS: usize = 16;
        if headers.len() > MAX_HEADERS {
            return Err(Rejected(format!(
                "Too many MCP server headers ({}); max {MAX_HEADERS}.",
                headers.len()
            )));
        }
        for (k, v) in headers.iter() {
            if !is_valid_header_name(k) {
                return Err(Rejected(format!(
                    "Invalid MCP header name `{k}`. Allowed: letters, digits, and `!#$%&'*+-.^_`|~`."
                )));
            }
            if !is_valid_header_value(v) {
                return Err(Rejected(format!(
                    "Invalid value for header `{k}`. Header values must be printable ASCII without CR/LF and ≤4096 bytes."
                )));
            }
        }
    }

    Ok(resolved)
}

#[tauri::command]
pub async fn mcp_list(state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    state.db.list_mcp_servers().map_err(err)
}

#[tauri::command]
pub async fn mcp_save(
    state: State<'_, AppState>,
    input: McpServerInput,
) -> Result<McpServer, String> {
    // We don't pin DNS on save (no network call), but we do still resolve
    // and screen so a save can't smuggle a private-IP-backed hostname into
    // the DB for a later, weaker code path to pick up.
    validate_mcp_input(&input).await?;

    let headers_json = input
        .headers
        .as_ref()
        .map(|m| serde_json::to_string(m).map_err(err))
        .transpose()?;

    let saved = state
        .db
        .upsert_mcp_server(
            input.id.as_deref(),
            input.name.trim(),
            input.url.trim(),
            headers_json.as_deref(),
            input.enabled.unwrap_or(true),
        )
        .map_err(err)?;
    // The cached tool catalogue (and the slugs derived from server names) is
    // now stale — drop it so the next send re-aggregates with this change.
    crate::mcp::invalidate_tools_cache(&state.mcp_tools_cache).await;
    Ok(saved)
}

#[tauri::command]
pub async fn mcp_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_mcp_server(&id).map_err(err)?;
    crate::mcp::invalidate_tools_cache(&state.mcp_tools_cache).await;
    Ok(())
}

/// Probe the given MCP server config (handshake + list tools). Accepts the
/// *input* rather than an id so the user can try a config before saving it.
#[tauri::command]
pub async fn mcp_test(input: McpServerInput) -> Result<McpTestResult, String> {
    let addrs = validate_mcp_input(&input).await?;
    let draft = input.to_draft();
    // Build a one-shot DNS-pinned client for the test. Using the shared
    // `state.http` would let the connect-time system resolver answer
    // independently of our pre-flight screen — a window a DNS-rebinding
    // attacker can drive a private address through. Pinning closes it.
    let parsed = reqwest::Url::parse(draft.url.trim())
        .map_err(|e| format!("Invalid MCP server URL: {e}"))?;
    let pinned = crate::tools::fetch_url::build_pinned_client(&parsed, &addrs)
        .map_err(|e| format!("could not build pinned client for MCP test: {e}"))?;
    Ok(mcp::test_server(&draft, &pinned).await)
}

// ---------- chat streaming ----------

#[derive(Debug, Serialize)]
pub struct StreamHandle {
    pub stream_id: String,
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    mut request: ChatRequest,
) -> Result<StreamHandle, String> {
    let stream_id = require_stream_id(std::mem::take(&mut request.stream_id))?;
    request.stream_id = stream_id.clone();
    let http = state.http.clone();
    let registry = state.streams.clone();
    let provider = request.provider.clone();
    let db = state.db.clone();
    let mcp_cache = state.mcp_tools_cache.clone();

    // Register the cancel Notify SYNCHRONOUSLY here — before we spawn the
    // worker — so a `chat_cancel(stream_id)` arriving while we're still
    // probing MCP servers actually takes effect. The previous shape
    // registered inside the provider's `chat_stream`, which meant any
    // cancel issued during the aggregate phase (up to 30 s per server)
    // hit an empty registry and was silently lost — the chat then ran to
    // completion anyway. Registering here closes that window.
    let cancel = registry.register(stream_id.clone());

    tauri::async_runtime::spawn(async move {
        let channel = crate::stream::event_channel(&request.stream_id);

        // Cancel-aware MCP aggregation. A slow / wedged server can keep
        // tools/list busy for the full 30 s timeout; the user must be
        // able to stop us during that wait.
        //
        // Private Chat skips this entirely: tool calls would let the model
        // autonomously forward prompt content to a user-configured MCP
        // server, which contradicts the "nothing leaves this box" promise
        // the overlay makes. Empty `tools` short-circuits the catalogue so
        // the model never sees a function it could call.
        let (tools, errors) = if request.private {
            (Vec::new(), Vec::new())
        } else {
            let agg_fut = crate::mcp::aggregate_tools_cached(&db, &mcp_cache);
            tokio::select! {
                biased;
                _ = cancel.notified() => {
                    let _ = app.emit(&channel, crate::stream::StreamEvent::Cancelled);
                    registry.finish(&request.stream_id);
                    return;
                }
                r = agg_fut => r,
            }
        };
        if !errors.is_empty() {
            // Full text goes to the operator-facing log (with whatever
            // identifying / debug detail the underlying error carried).
            let log_summary = errors
                .iter()
                .map(|(name, e)| format!("{name}: {e}"))
                .collect::<Vec<_>>()
                .join("; ");
            tracing::warn!("MCP aggregate errors — {log_summary}");
            // The chat-bubble notice is sanitised: every error string is
            // collapsed to a single line and truncated. A misbehaving MCP
            // server that echoes an `Authorization` header (or any other
            // secret) into its 401 body would otherwise land that text in
            // the persisted message — and from there into snapshots and
            // shared exports. Truncation is conservative; the operator
            // still has the full text in the log above.
            let ui_summary = errors
                .iter()
                .map(|(name, e)| format!("{name}: {}", sanitize_chat_error(e)))
                .collect::<Vec<_>>()
                .join("; ");
            // Surface to the user so a totally-broken MCP config isn't
            // silently invisible. We prepend ONE notice (not a sequence of
            // Error events — those trigger teardown in the frontend) as a
            // Token, so it lands at the head of the assistant bubble and
            // the chat continues normally with whatever tools survived.
            let notice = format!(
                "_⚠ Some MCP servers couldn't be reached: {ui_summary}. Continuing with the rest._\n\n"
            );
            let _ = app.emit(
                &channel,
                crate::stream::StreamEvent::Token { delta: notice },
            );
        }
        request.tools = tools;

        // Append built-in tools after the MCP catalogue. Order is safe:
        // MCP qualified names always carry a `<slug>__` prefix, so the
        // bare names used by built-ins (`calculate`, `datetime`, …)
        // can't collide with `resolve_qualified`'s first-match scan.
        //
        // Built-ins are purely local (no network, no DB writes), so we
        // expose them in Private Chat too — the privacy guarantee is
        // about data leaving the box, not about hiding local compute.
        request
            .tools
            .extend(crate::tools::builtin::enabled_builtin_defs(&db));

        let res = match provider.as_str() {
            "ollama" => {
                providers::ollama::chat_stream(app, http, registry, db, cancel, request).await
            }
            "openai" => {
                providers::openai::chat_stream(app, http, registry, db, cancel, request).await
            }
            other => {
                tracing::warn!("unknown provider {other}");
                // No provider ran, so nothing emitted a terminal frame or
                // released the registry entry. Without this the frontend's
                // stream listener never sees Done/Error/Cancelled — the
                // bubble stays stuck "generating" forever — and the cancel
                // Notify leaks. Emit an Error (which the UI treats as a
                // terminal event) and finish the registry entry, mirroring
                // what the provider paths do internally.
                let _ = app.emit(
                    &channel,
                    crate::stream::StreamEvent::Error {
                        message: format!(
                            "Unknown provider \"{other}\". Pick a model again to repair this chat."
                        ),
                    },
                );
                registry.finish(&request.stream_id);
                Ok(())
            }
        };
        if let Err(e) = res {
            tracing::warn!("chat stream ended with error: {e:?}");
        }
    });

    Ok(StreamHandle { stream_id })
}

#[tauri::command]
pub async fn chat_cancel(state: State<'_, AppState>, stream_id: String) -> Result<(), String> {
    state.streams.cancel(&stream_id);
    Ok(())
}

// ---------- tools ----------

/// Fetch a public URL and return cleaned, bounded text the frontend can
/// inline into the user's prompt. See [`crate::tools::fetch_url`] for the
/// hardening details (SSRF guard, timeout, body cap).
#[tauri::command]
pub async fn fetch_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<FetchedPage, String> {
    fetch_url_tool::fetch(&state.http, &url).await
}

// ---------- data (export / import / wipe) ----------
//
// Powers the Settings → Data tab. The Rust side owns every step that the
// renderer would otherwise have to be trusted with: opening the native
// dialog, reading / writing the file at the user-chosen path, gating the
// destructive actions on the app-lock credentials. A compromised renderer
// can still call these commands directly, but it cannot:
//   - write to a path the user didn't pick (no raw `write_text_file`),
//   - read a path the user didn't pick (no raw `import_data_json(path)`),
//   - drop user data without supplying the current app-lock credentials.

/// Optional file filter for the save / open dialog (`{name: "JSON",
/// extensions: ["json"]}`). Mirrors the shape `@tauri-apps/plugin-dialog`
/// uses on the frontend so the renderer can keep its existing call shape.
#[derive(Debug, Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Open a native save dialog and write `content` to whichever path the
/// user picks. Returns the chosen path (string), or `None` if the user
/// cancelled.
///
/// Replaces the previous `write_text_file(path, content)` + frontend
/// `dialog.save` pair. Moving the dialog INTO the backend closes the gap
/// where a compromised renderer could skip the dialog entirely and write
/// to an arbitrary path (e.g. `~/.bashrc`): now the only path the backend
/// will write to is one the user just clicked through a native picker.
/// Hard ceiling on what the renderer can ask us to save. Real exports
/// (full DB snapshots) are in the low MBs; this cap is generous enough
/// for any realistic dump while rejecting a compromised renderer that
/// sends multi-gigabyte payloads in an attempt to OOM the process or
/// fill the user's disk.
const MAX_SAVE_BYTES: usize = 256 * 1024 * 1024; // 256 MB

/// Gate a destructive command on the app-lock credentials.
///
/// Runs on the blocking pool: argon2id at m=64 MiB / t=3 plus a keyring read
/// is 100-250 ms of pinned CPU and a possible DBus round-trip. The `security_*`
/// commands offload this for the stated reason that "a slow unlock attempt can
/// stall every other in-flight command"; the destructive paths were the
/// exception until this was hoisted out of all three of them.
async fn check_destructive_auth(auth: Option<DestructiveAuthArgs>) -> Result<(), String> {
    let auth = auth.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        security::require_unlocked(auth.pin.as_deref(), auth.password.as_deref())
    })
    .await
    .map_err(|e| format!("unlock check panicked: {e}"))?
    .map_err(err)
}

/// Shared body of `save_text_to_file` / `save_binary_to_file`: put up the
/// save dialog, then write `bytes` to whatever the user picked. Returns
/// `Ok(None)` when they cancel.
///
/// Both the dialog and the write go on the blocking pool. An earlier version
/// offloaded only the dialog and then called `std::fs::write` back on the
/// async runtime, which parked a runtime worker on synchronous I/O for the
/// length of a multi-MB export.
async fn save_bytes_via_dialog(
    app: AppHandle,
    bytes: Vec<u8>,
    default_path: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let path_opt = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(name) = default_path.as_deref() {
            builder = builder.set_file_name(name);
        }
        if let Some(filters) = filters.as_ref() {
            for f in filters {
                let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
                builder = builder.add_filter(&f.name, &exts);
            }
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| format!("save dialog task failed: {e}"))?;

    let chosen = match path_opt {
        Some(fp) => fp,
        None => return Ok(None),
    };
    let path = chosen
        .into_path()
        .map_err(|e| format!("invalid path returned from dialog: {e}"))?;

    let returned_path = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&path, bytes))
        .await
        .map_err(|e| format!("save task panicked: {e}"))?
        .map_err(|e| format!("couldn't write {}: {e}", returned_path.display()))?;

    Ok(Some(returned_path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn save_text_to_file(
    app: AppHandle,
    content: String,
    default_path: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<String>, String> {
    if content.len() > MAX_SAVE_BYTES {
        return Err(format!(
            "save_text_to_file refused: content is {} bytes (cap {} bytes)",
            content.len(),
            MAX_SAVE_BYTES
        ));
    }
    save_bytes_via_dialog(app, content.into_bytes(), default_path, filters).await
}

/// Binary sibling of `save_text_to_file` — accepts base64-encoded bytes,
/// decodes them in Rust, and writes the raw bytes to a user-chosen path.
/// Powers "Save image" from the in-chat preview, where the image is already
/// held in memory as base64 on an `Attachment`.
#[tauri::command]
pub async fn save_binary_to_file(
    app: AppHandle,
    base64_data: String,
    default_path: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    if base64_data.len() > MAX_SAVE_BYTES {
        return Err(format!(
            "save_binary_to_file refused: payload is {} bytes (cap {} bytes)",
            base64_data.len(),
            MAX_SAVE_BYTES
        ));
    }

    let bytes = STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;

    save_bytes_via_dialog(app, bytes, default_path, filters).await
}

/// Row counts and byte totals for the Settings -> Data storage tile.
///
/// On the blocking pool for the same reason as `export_data_json`: the
/// `SUM(LENGTH(...))` scans walk every message and space file, including
/// their inlined base64 bodies, so on an attachment-heavy database this is
/// firmly CPU-bound and would otherwise stall a runtime worker.
#[tauri::command]
pub async fn storage_stats(state: State<'_, AppState>) -> Result<StorageStats, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.storage_stats().map_err(err))
        .await
        .map_err(|e| format!("storage stats task panicked: {e}"))?
}

/// Serialise every table to a JSON string. Pretty-printed so users can
/// diff or grep an export manually. The schema tag `"loach/v1"` is the
/// forward-compat knob — `import_data_with_dialog` rejects anything else.
#[tauri::command]
pub async fn export_data_json(state: State<'_, AppState>) -> Result<String, String> {
    // `snapshot()` reads every table (messages and space files carry inlined
    // base64 bodies) under the DB lock, and the pretty-print doubles that in
    // memory — both CPU-bound and both blocking. The import counterpart is
    // already on the blocking pool for exactly this reason; the export half
    // wasn't, so a large attachment-heavy database stalled a runtime worker
    // and queued every other command behind it.
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let snap = db.snapshot().map_err(err)?;
        serde_json::to_string_pretty(&snap).map_err(err)
    })
    .await
    .map_err(|e| format!("export task panicked: {e}"))?
}

#[derive(Debug, Deserialize, Default)]
pub struct DestructiveAuthArgs {
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Open a native open-file dialog, read the JSON, validate the schema, and
/// apply it via `restore_snapshot`. Returns `Ok(None)` if the user cancelled
/// the dialog.
///
/// Gated on the app-lock credentials whenever a lock is configured —
/// importing replaces every row in the database, so it gets the same
/// confirmation a renderer-driven destructive action would.
#[tauri::command]
pub async fn import_data_with_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
    auth: Option<DestructiveAuthArgs>,
) -> Result<Option<ImportStats>, String> {
    use tauri_plugin_dialog::DialogExt;

    check_destructive_auth(auth).await?;

    let path_opt = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Loach export", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("open dialog task failed: {e}"))?;

    let chosen = match path_opt {
        Some(fp) => fp,
        None => return Ok(None),
    };
    let path = chosen
        .into_path()
        .map_err(|e| format!("invalid path returned from dialog: {e}"))?;

    // Stage 1 — file read + JSON parse on the blocking pool. The IO + serde
    // pass blocks for as long as the file is large, so we don't want it on
    // the tokio runtime.
    let mut snap: DatabaseSnapshot =
        tokio::task::spawn_blocking(move || -> Result<DatabaseSnapshot, String> {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
            let snap: DatabaseSnapshot = serde_json::from_str(&text)
                .map_err(|e| format!("file doesn't look like a Loach export: {e}"))?;
            if snap.schema != "loach/v1" {
                return Err(format!(
                    "unsupported export schema '{}' — this build expects 'loach/v1'",
                    snap.schema
                ));
            }
            Ok(snap)
        })
        .await
        .map_err(|e| format!("import parse task panicked: {e}"))??;

    // Stage 2 — re-validate every MCP server row before letting it back
    // into the DB. The `mcp_save` path runs through `validate_mcp_input`,
    // but the snapshot bypasses that — a hand-edited or maliciously
    // crafted export could otherwise smuggle in rows pointing at the
    // cloud-metadata service or other link-local addresses. We re-screen
    // each here using the same async validator (DNS lookup + headers
    // structural check) so the user can't shoot themselves in the foot by
    // importing a tampered file.
    let mut quarantined: Vec<String> = Vec::new();
    for (idx, row) in snap.data.mcp_servers.iter_mut().enumerate() {
        let parsed_headers: Option<std::collections::HashMap<String, String>> =
            match row.headers_json.as_deref() {
                Some(s) if !s.trim().is_empty() => serde_json::from_str(s).map_err(|e| {
                    format!(
                        "import rejected: MCP server #{} ({}) has malformed headers_json: {e}",
                        idx + 1,
                        row.name
                    )
                })?,
                _ => None,
            };
        let synthetic = McpServerInput {
            id: Some(row.id.clone()),
            name: row.name.clone(),
            url: row.url.clone(),
            headers: parsed_headers,
            enabled: Some(row.enabled),
        };
        match validate_mcp_input(&synthetic).await {
            Ok(_) => {}
            // The host couldn't be screened because DNS didn't answer — the
            // machine is offline, off the VPN, or the box has since been
            // decommissioned. That says nothing about whether the row is
            // hostile, and refusing the whole snapshot over it meant one
            // stale integration could cost the user every chat, space and
            // snippet in their backup. Keep the row but force it disabled:
            // nothing connects to it until the user re-saves it, which runs
            // the full validator on the normal path.
            Err(McpImportRejection::Unscreenable(msg)) => {
                row.enabled = false;
                quarantined.push(format!("{} ({msg})", row.name));
            }
            // Positively identified as link-local, or structurally bad.
            // Still a hard reject: this is the tampered-export case the
            // re-validation exists to catch.
            Err(McpImportRejection::Rejected(msg)) => {
                return Err(format!(
                    "import rejected: MCP server #{} ({}): {msg}",
                    idx + 1,
                    row.name
                ));
            }
        }
    }
    // Stage 2.6 — screen message roles and session providers. `append_message`
    // and `import_messages` both run `validate_role`, precisely so a crafted
    // row can't store an arbitrary role that the chat-history builder then
    // forwards to the provider — but `restore_snapshot` inserts `m.role`
    // verbatim, which re-opens exactly that door for a hand-edited export.
    for (idx, m) in snap.data.messages.iter().enumerate() {
        validate_role(&m.role).map_err(|e| {
            format!("import rejected: message #{} ({}): {e}", idx + 1, m.id)
        })?;
    }
    for (idx, s) in snap.data.sessions.iter().enumerate() {
        if s.provider != "ollama" && s.provider != "openai" {
            return Err(format!(
                "import rejected: chat #{} ({}) has unknown provider `{}`",
                idx + 1,
                s.title,
                s.provider
            ));
        }
    }

    if !quarantined.is_empty() {
        tracing::warn!(
            "import: {} MCP server(s) could not be screened and were imported disabled: {}",
            quarantined.len(),
            quarantined.join(", ")
        );
    }

    // Stage 2.5 — filter imported settings through the SAME allowlist
    // `set_setting` enforces. `restore_snapshot` writes settings rows
    // verbatim, which otherwise bypasses the gate entirely: a hand-edited
    // export could plant arbitrary keys or repoint `openai_base_url` at an
    // attacker host — the exact attack `set_setting`'s allowlist closes.
    // (We deliberately do NOT value-screen base URLs: they're freely
    // user-writable on the normal path — local proxies like LM Studio need
    // `localhost:1234` — so the import path matches that.)
    let before = snap.data.settings.len();
    snap.data
        .settings
        .retain(|(k, _)| is_writable_setting_key(k));
    let dropped = before - snap.data.settings.len();
    if dropped > 0 {
        tracing::warn!(
            "import: dropped {dropped} setting(s) not on the writable allowlist"
        );
    }

    // Stage 3 — apply. `restore_snapshot` holds the single DB mutex for
    // the duration of the transaction and inserts every row serially, so
    // it has to run on the blocking pool too.
    let db = state.db.clone();
    let stats = tokio::task::spawn_blocking(move || -> Result<ImportStats, String> {
        db.restore_snapshot(&snap).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("import restore task panicked: {e}"))??;

    // The restore rewrote the mcp_servers table — drop any cached catalogue.
    crate::mcp::invalidate_tools_cache(&state.mcp_tools_cache).await;
    Ok(Some(stats))
}

/// Archive every non-archived session in one go. The Rust side returns
/// the number of rows it actually flipped so the UI can say "Archived 8
/// chats" vs. "Nothing to archive".
#[tauri::command]
pub async fn archive_all_sessions(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.archive_all_sessions().map_err(err)
}

/// Permanently delete every archived session. Irreversible — messages
/// cascade. Returns the row count so the UI can say "Removed 8 chats".
///
/// Intentionally **not** gated on `require_unlocked`, unlike the
/// nuke-everything commands (`wipe_user_data`, `factory_reset`,
/// `import_data_with_dialog`). This sits in the same tier as the ungated
/// per-session `delete_session` / `delete_message`: ordinary user-initiated
/// deletes of content the renderer can already enumerate. Gating *only* this
/// command would be security theater — a compromised renderer can achieve the
/// identical bulk deletion by looping the ungated `delete_session` over the
/// archived ids. The app-lock's re-auth boundary deliberately protects the
/// one-shot catastrophic resets, not every delete. The UI still shows a
/// destructive confirmation before calling this.
#[tauri::command]
pub async fn delete_archived_sessions(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.delete_archived_sessions().map_err(err)
}

/// Delete chats / spaces / snippets / MCP servers but leave app
/// settings (theme, provider URLs, system prompt, etc.) intact. The
/// OpenAI key — which lives in the OS credential manager, not SQLite —
/// also survives. Use [`factory_reset`] for the nuclear option.
///
/// Gated on the app-lock credentials when a lock is configured.
#[tauri::command]
pub async fn wipe_user_data(
    state: State<'_, AppState>,
    auth: Option<DestructiveAuthArgs>,
) -> Result<(), String> {
    check_destructive_auth(auth).await?;
    state.db.wipe_user_data().map_err(err)?;
    // The wipe deletes every `mcp_servers` row, so the cached tool catalogue
    // is now stale. The webview reloads afterwards but `AppState` doesn't, so
    // without this the next chat send would still advertise the just-erased
    // servers' tools to the model for up to the cache TTL.
    crate::mcp::invalidate_tools_cache(&state.mcp_tools_cache).await;
    Ok(())
}

/// Factory reset: wipe_user_data + drop all settings + clear the stored
/// OpenAI key. After this the app should look exactly like a fresh
/// install, save for the DB file itself (which is empty but preserved).
///
/// Gated on the app-lock credentials when a lock is configured. The
/// internal `security::clear()` it calls afterwards is the unchecked
/// path — by this point the user has already authenticated against the
/// lock once via `require_unlocked`, so the keyring purge that follows
/// doesn't need a second check.
#[tauri::command]
pub async fn factory_reset(
    state: State<'_, AppState>,
    auth: Option<DestructiveAuthArgs>,
) -> Result<(), String> {
    check_destructive_auth(auth).await?;
    state.db.wipe_all().map_err(err)?;
    // Same reason as in `wipe_user_data`: the MCP rows are gone, so the
    // in-process tool catalogue has to go with them.
    crate::mcp::invalidate_tools_cache(&state.mcp_tools_cache).await;
    // Best-effort: if the user never had a key we silently ignore the
    // NoEntry branch inside `clear_openai_key`. A hard failure here
    // (keyring daemon dead, etc.) shouldn't undo the DB wipe. Both are
    // blocking keyring calls, so they go to the blocking pool too.
    let _ = tokio::task::spawn_blocking(|| {
        if let Err(e) = secrets::clear_openai_key() {
            tracing::warn!("clear_openai_key during factory_reset failed: {e:?}");
        }
        if let Err(e) = security::clear() {
            tracing::warn!("security::clear during factory_reset failed: {e:?}");
        }
    })
    .await;
    Ok(())
}

// ---------- open in external editor ----------
//
// The code canvas holds a snippet, not a file. "Open in VS Code" writes the
// current snapshot to a scratch file (the renderer supplies the language-derived
// filename; we own the directory and reduce the name to a bare basename so a
// compromised renderer can't write outside it) and launches VS Code's `code`
// CLI on it. Snapshot only — it does not stream as the block keeps generating.

#[tauri::command]
pub async fn open_in_vscode(
    app: AppHandle,
    code: String,
    filename: String,
) -> Result<(), String> {
    use tauri::Manager;
    // Deliberately the app's own cache dir rather than the shared temp root.
    // `std::env::temp_dir()` is /tmp on Linux — world-writable, so another
    // local user could pre-create `loach-canvas` and plant symlinks that
    // redirect our write to a path of their choosing, with this user's
    // privileges (CWE-379). The per-user cache dir has no such window.
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Couldn't resolve the app cache directory: {e}"))?
        .join("canvas");
    // Everything below is blocking — `create_dir_all`, a file write, and on
    // Windows a spawn-and-wait `where code` PATH scan. Running it inline on
    // the main thread visibly hitched the UI for as long as a cold PATH scan
    // took.
    tokio::task::spawn_blocking(move || open_in_vscode_blocking(dir, code, filename))
        .await
        .map_err(|e| format!("editor task panicked: {e}"))?
}

fn open_in_vscode_blocking(
    dir: std::path::PathBuf,
    code: String,
    filename: String,
) -> Result<(), String> {
    use std::io::Write;
    use std::process::Command;

    // Honour only the basename — never directory components the renderer may
    // have sent — so the write can't escape the temp dir.
    //
    // Then reduce that basename to a conservative charset. On Windows the
    // path is handed to `cmd /C code <path>`, and a Windows filename may
    // legally contain shell metacharacters (`&`, `^`, `(`, `)`, spaces) that
    // `cmd` parses — e.g. a renderer-supplied name like `a&calc&b.txt` would
    // execute `calc`. `std::process::Command` only quotes args containing
    // spaces, so a no-space metacharacter slips through unquoted. Replacing
    // anything outside `[A-Za-z0-9._-]` with `_` makes the name inert as a
    // shell token while preserving the extension VS Code reads to pick a
    // language mode. The filename is only a cosmetic label on a throwaway
    // temp file, so this is lossless in practice.
    let raw_name = std::path::Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let mut safe_name: String = raw_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Reject empty / dots-only results (`""`, `.`, `..`, `...`) which aren't
    // a usable file name once the metacharacters are stripped.
    if safe_name.trim_matches('.').is_empty() {
        safe_name = "snippet.txt".to_string();
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Couldn't create the scratch folder: {e}"))?;
    let path = dir.join(&safe_name);
    std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(code.as_bytes()))
        .map_err(|e| format!("Couldn't write the temp file: {e}"))?;

    let not_found = "VS Code's `code` command isn't on your PATH. Open VS Code and run \
                     \"Shell Command: Install 'code' command in PATH\", then try again."
        .to_string();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CreateProcess can't run `code.cmd` directly, so go through cmd. cmd
        // also swallows a missing-`code` error (it exits non-zero rather than
        // failing to spawn), so confirm presence with `where` first.
        // CREATE_NO_WINDOW stops a console from flashing on screen.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let present = Command::new("where")
            .arg("code")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !present {
            return Err(not_found);
        }
        Command::new("cmd")
            .args(["/C", "code"])
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Couldn't launch VS Code: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        // GUI apps launched from Finder/Dock inherit a minimal PATH
        // (/usr/bin:/bin:/usr/sbin:/sbin) that excludes /usr/local/bin (Intel)
        // and /opt/homebrew/bin (Apple Silicon) where VS Code's `code` shim
        // lives, so spawning `code` directly fails even when it works from a
        // terminal. `open` is always at /usr/bin/open and resolves the app
        // through LaunchServices, which doesn't depend on PATH. `.status()`
        // returns as soon as `open` hands off (fast) and is non-zero when the
        // app can't be found, so we can still surface the `not_found` hint.
        let status = Command::new("open")
            .args(["-a", "Visual Studio Code"])
            .arg(&path)
            .status()
            .map_err(|e| format!("Couldn't launch VS Code: {e}"))?;
        if !status.success() {
            return Err(not_found);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("code").arg(&path).spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                not_found
            } else {
                format!("Couldn't launch VS Code: {e}")
            }
        })?;
    }

    Ok(())
}

// ---------- updater support ----------
//
// The Tauri updater can replace a Windows NSIS install or a Linux AppImage in
// place. Since updater plugin 2.10 it can also upgrade `.deb`/`.rpm` installs:
// it downloads the signed package advertised by the format-specific
// `latest.json` key (`linux-x86_64-deb` / `-rpm`) and elevates via pkexec
// (falling back to zenity/kdialog + sudo) to run `dpkg -i` / `rpm -U`, so the
// package database stays consistent. On macOS the updater patches the `.app`
// bundle in place; that works even though we don't sign with Apple, because
// the updater's integrity check uses our own Ed25519 signature (separate from
// Apple notarization). We expose this so the UI can hide the "Check for
// updates" affordance when running from an unsupported install type, instead
// of letting the user click and hit a confusing failure.
#[tauri::command]
pub fn updater_supported() -> bool {
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        // AppImage runtimes set $APPIMAGE to the absolute path of the running
        // bundle; nothing else does. For `.deb`/`.rpm` we read the bundle-type
        // marker the bundler patches into the binary at build time — the same
        // marker the updater plugin keys its install path off, so this gate
        // can't disagree with what the plugin would actually do. Dev builds
        // and `cargo run` have no marker and report unsupported, as before.
        use tauri::utils::{config::BundleType, platform::bundle_type};
        std::env::var("APPIMAGE").is_ok()
            || matches!(bundle_type(), Some(BundleType::Deb | BundleType::Rpm))
    }
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        false
    }
}
