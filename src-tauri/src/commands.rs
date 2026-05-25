use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{
    DatabaseSnapshot, ImportStats, McpServer, Message, Session, Snippet, Space, SpaceFile,
    SpaceMemory,
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

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Message>, String> {
    state.db.list_messages(&session_id).map_err(err)
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

// ---------- settings ----------

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let rows = state.db.all_settings().map_err(err)?;
    Ok(rows.into_iter().collect())
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
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

// ---------- providers ----------

#[tauri::command]
pub async fn ollama_probe(state: State<'_, AppState>, base_url: String) -> Result<bool, String> {
    Ok(providers::ollama::probe(&state.http, &base_url).await)
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
) -> Result<(), String> {
    providers::ollama::preload_model(&state.http, &base_url, &model)
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
    let stream_id = if args.stream_id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        args.stream_id
    };
    let http = state.http.clone();
    let registry = state.streams.clone();
    let sid = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            providers::ollama::pull_model(app, http, registry, &args.base_url, &args.name, sid)
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
    let stream_id = if args.stream_id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        args.stream_id
    };
    let http = state.http.clone();
    let registry = state.streams.clone();
    let sid = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = providers::ollama::create_model(
            app,
            http,
            registry,
            &args.base_url,
            &args.name,
            &args.modelfile,
            sid,
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

#[tauri::command]
pub async fn get_space(state: State<'_, AppState>, id: String) -> Result<Option<Space>, String> {
    state.db.get_space(&id).map_err(err)
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
async fn validate_mcp_input(
    input: &McpServerInput,
) -> Result<Vec<std::net::SocketAddr>, String> {
    if input.name.trim().is_empty() {
        return Err("server name is required".into());
    }
    let raw_url = input.url.trim();
    if raw_url.is_empty() {
        return Err("server URL is required".into());
    }

    // Scheme + host validation. We refuse anything that isn't http/https and
    // anything that resolves to a private / loopback / link-local address. A
    // misconfigured server can still expose secrets, but at least a header
    // smuggled in by a compromised renderer can't be aimed at an internal
    // service the user wouldn't otherwise reach (cloud metadata service,
    // internal admin endpoints, etc.).
    let parsed = reqwest::Url::parse(raw_url)
        .map_err(|e| format!("Invalid MCP server URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("MCP server URL must be http or https (got `{other}`)")),
    }

    // Defer to the same resolver `fetch_url` uses: literal IPs are
    // rejected if non-public, hostnames are DNS-resolved and every
    // returned address screened. Returning the addresses lets the caller
    // pin them into a per-request client at connect time so a malicious
    // DNS server can't flip the answer between validate and dial.
    let resolved = crate::tools::fetch_url::resolve_safe_addrs(&parsed)
        .await
        .map_err(|e| format!("MCP server URL rejected: {e}"))?;

    // Header k/v validation. We do NOT call out to the network here, so the
    // only protection we can offer is structural: reject names / values
    // that would let an attacker smuggle CRLF-injected headers via a
    // crafted save call.
    if let Some(headers) = input.headers.as_ref() {
        const MAX_HEADERS: usize = 16;
        if headers.len() > MAX_HEADERS {
            return Err(format!(
                "Too many MCP server headers ({}); max {MAX_HEADERS}.",
                headers.len()
            ));
        }
        for (k, v) in headers.iter() {
            if !is_valid_header_name(k) {
                return Err(format!(
                    "Invalid MCP header name `{k}`. Allowed: letters, digits, and `!#$%&'*+-.^_`|~`."
                ));
            }
            if !is_valid_header_value(v) {
                return Err(format!(
                    "Invalid value for header `{k}`. Header values must be printable ASCII without CR/LF and ≤4096 bytes."
                ));
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

    state
        .db
        .upsert_mcp_server(
            input.id.as_deref(),
            input.name.trim(),
            input.url.trim(),
            headers_json.as_deref(),
            input.enabled.unwrap_or(true),
        )
        .map_err(err)
}

#[tauri::command]
pub async fn mcp_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_mcp_server(&id).map_err(err)
}

/// Probe the given MCP server config (handshake + list tools). Accepts the
/// *input* rather than an id so the user can try a config before saving it.
#[tauri::command]
pub async fn mcp_test(
    _state: State<'_, AppState>,
    input: McpServerInput,
) -> Result<McpTestResult, String> {
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
    if request.stream_id.is_empty() {
        request.stream_id = Uuid::new_v4().to_string();
    }
    let stream_id = request.stream_id.clone();
    let http = state.http.clone();
    let registry = state.streams.clone();
    let provider = request.provider.clone();
    let db = state.db.clone();

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
            let agg_fut = crate::mcp::aggregate_tools(&db);
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
            let summary = errors
                .iter()
                .map(|(name, e)| format!("{name}: {e}"))
                .collect::<Vec<_>>()
                .join("; ");
            tracing::warn!("MCP aggregate errors — {summary}");
            // Surface to the user so a totally-broken MCP config isn't
            // silently invisible. We prepend ONE notice (not a sequence of
            // Error events — those trigger teardown in the frontend) as a
            // Token, so it lands at the head of the assistant bubble and
            // the chat continues normally with whatever tools survived.
            let notice = format!(
                "_⚠ Some MCP servers couldn't be reached: {summary}. Continuing with the rest._\n\n"
            );
            let _ = app.emit(
                &channel,
                crate::stream::StreamEvent::Token { delta: notice },
            );
        }
        request.tools = tools;

        let res = match provider.as_str() {
            "ollama" => {
                providers::ollama::chat_stream(app, http, registry, db, cancel, request).await
            }
            "openai" => {
                providers::openai::chat_stream(app, http, registry, db, cancel, request).await
            }
            other => {
                tracing::warn!("unknown provider {other}");
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

#[tauri::command]
pub async fn save_text_to_file(
    app: AppHandle,
    content: String,
    default_path: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    if content.len() > MAX_SAVE_BYTES {
        return Err(format!(
            "save_text_to_file refused: content is {} bytes (cap {} bytes)",
            content.len(),
            MAX_SAVE_BYTES
        ));
    }

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

    // The actual write needs to be on the blocking pool too. The previous
    // version only put the dialog in `spawn_blocking`, then called
    // `std::fs::write` back on the async runtime — a multi-MB export
    // would park the runtime worker on synchronous I/O.
    let returned_path = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&path, content))
        .await
        .map_err(|e| format!("save task panicked: {e}"))?
        .map_err(|e| format!("couldn't write {}: {e}", returned_path.display()))?;

    Ok(Some(returned_path.to_string_lossy().to_string()))
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
    use tauri_plugin_dialog::DialogExt;

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

/// Serialise every table to a JSON string. Pretty-printed so users can
/// diff or grep an export manually. The schema tag `"loach/v1"` is the
/// forward-compat knob — `import_data_with_dialog` rejects anything else.
#[tauri::command]
pub async fn export_data_json(state: State<'_, AppState>) -> Result<String, String> {
    let snap = state.db.snapshot().map_err(err)?;
    serde_json::to_string_pretty(&snap).map_err(err)
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

    let auth = auth.unwrap_or_default();
    security::require_unlocked(auth.pin.as_deref(), auth.password.as_deref())
        .map_err(err)?;

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
    let snap: DatabaseSnapshot =
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
    // crafted export could otherwise smuggle in rows pointing at
    // localhost, RFC1918 ranges, or hosts that resolve to internal IPs.
    // We re-screen each here using the same async validator (DNS lookup
    // + headers structural check) so the user can't shoot themselves in
    // the foot by importing a tampered file.
    for (idx, row) in snap.data.mcp_servers.iter().enumerate() {
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
        validate_mcp_input(&synthetic).await.map_err(|e| {
            format!(
                "import rejected: MCP server #{} ({}): {e}",
                idx + 1,
                row.name
            )
        })?;
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
    let auth = auth.unwrap_or_default();
    security::require_unlocked(auth.pin.as_deref(), auth.password.as_deref())
        .map_err(err)?;
    state.db.wipe_user_data().map_err(err)
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
    let auth = auth.unwrap_or_default();
    security::require_unlocked(auth.pin.as_deref(), auth.password.as_deref())
        .map_err(err)?;
    state.db.wipe_all().map_err(err)?;
    // Best-effort: if the user never had a key we silently ignore the
    // NoEntry branch inside `clear_openai_key`. A hard failure here
    // (keyring daemon dead, etc.) shouldn't undo the DB wipe.
    if let Err(e) = secrets::clear_openai_key() {
        tracing::warn!("clear_openai_key during factory_reset failed: {e:?}");
    }
    if let Err(e) = security::clear() {
        tracing::warn!("security::clear during factory_reset failed: {e:?}");
    }
    Ok(())
}

// ---------- updater support ----------
//
// The Tauri updater can replace a Windows NSIS install or a Linux AppImage in
// place, but it cannot upgrade a `.deb`/`.rpm` install — that has to go
// through the system package manager. On macOS the updater patches the `.app`
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
        // bundle; nothing else does. Absence of the var means we're running
        // from a `.deb`, a dev build, or `cargo run` — none of which the
        // updater plugin can patch.
        std::env::var("APPIMAGE").is_ok()
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
