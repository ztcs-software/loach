use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
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
    pub content: String,
    pub thinking: Option<String>,
    pub metrics_json: Option<String>,
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
            &args.content,
            args.thinking.as_deref(),
            args.metrics_json.as_deref(),
        )
        .map_err(err)
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
    secrets::set_openai_key(&key).map_err(err)
}

#[tauri::command]
pub async fn get_openai_key_status() -> Result<bool, String> {
    Ok(secrets::has_openai_key())
}

#[tauri::command]
pub async fn clear_openai_key() -> Result<(), String> {
    secrets::clear_openai_key().map_err(err)
}

// ---------- security (app lock) ----------

#[tauri::command]
pub async fn security_status() -> Result<LockStatus, String> {
    security::status().map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct SecuritySetupArgs {
    pub method: LockMethod,
    pub pin: Option<String>,
    pub password: Option<String>,
    pub pin_length: Option<u8>,
    pub hint: Option<String>,
}

#[tauri::command]
pub async fn security_setup(args: SecuritySetupArgs) -> Result<(), String> {
    security::setup(
        args.method,
        args.pin.as_deref(),
        args.password.as_deref(),
        args.pin_length,
        args.hint,
    )
    .map_err(err)
}

#[derive(Debug, Deserialize)]
pub struct SecurityUnlockArgs {
    pub pin: Option<String>,
    pub password: Option<String>,
}

#[tauri::command]
pub async fn security_unlock(args: SecurityUnlockArgs) -> Result<bool, String> {
    security::unlock(args.pin.as_deref(), args.password.as_deref()).map_err(err)
}

#[tauri::command]
pub async fn security_get_hint() -> Result<Option<String>, String> {
    security::get_hint().map_err(err)
}

#[tauri::command]
pub async fn security_clear() -> Result<(), String> {
    security::clear().map_err(err)
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
    pub content: String,
}

#[tauri::command]
pub async fn update_space_memory(
    state: State<'_, AppState>,
    args: UpdateSpaceMemoryArgs,
) -> Result<(), String> {
    state.db.update_space_memory(&args.id, args.content.trim()).map_err(err)
}

#[tauri::command]
pub async fn remove_space_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.remove_space_memory(&id).map_err(err)
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

fn validate_mcp_input(input: &McpServerInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("server name is required".into());
    }
    if input.url.trim().is_empty() {
        return Err("server URL is required".into());
    }
    Ok(())
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
    validate_mcp_input(&input)?;

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
    state: State<'_, AppState>,
    input: McpServerInput,
) -> Result<McpTestResult, String> {
    validate_mcp_input(&input)?;
    let draft = input.to_draft();
    Ok(mcp::test_server(&draft, &state.http).await)
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

    tauri::async_runtime::spawn(async move {
        let res = match provider.as_str() {
            "ollama" => providers::ollama::chat_stream(app, http, registry, request).await,
            "openai" => providers::openai::chat_stream(app, http, registry, request).await,
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

/// Write `contents` to `path` as UTF-8. The path comes from the dialog
/// plugin's save sheet, so the user has explicitly authorised it — we do
/// the IO in Rust to sidestep the `fs` plugin's scope, which only covers
/// a handful of known directories and silently rejects things like the
/// Desktop. Mirrors the read-side trick in [`import_data_json`].
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("couldn't write {path}: {e}"))
}

// ---------- data (export / import / wipe) ----------
//
// Powers the Settings → Data tab. Keeping all four actions here (rather
// than scattered across files) makes the surface area obvious: the user
// can dump their entire DB, restore from a dump, bulk-archive, or nuke
// it back to factory defaults — and nothing else in the Rust layer needs
// to know these exist.

/// Serialise every table to a JSON string. Pretty-printed so users can
/// diff or grep an export manually. The schema tag `"loach/v1"` is the
/// forward-compat knob — `import_data_json` rejects anything else.
#[tauri::command]
pub async fn export_data_json(state: State<'_, AppState>) -> Result<String, String> {
    let snap = state.db.snapshot().map_err(err)?;
    serde_json::to_string_pretty(&snap).map_err(err)
}

/// Read a JSON file from disk and replace every table with its contents.
/// Returns a per-table row-count breakdown so the UI can show a toast
/// like "Imported 12 chats · 145 messages · 3 spaces".
///
/// We take a path (not the raw text) so the frontend doesn't need `fs`
/// read permission: the dialog plugin hands us a user-blessed path, we
/// open it ourselves.
#[tauri::command]
pub async fn import_data_json(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportStats, String> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("couldn't read {path}: {e}"))?;
    let snap: DatabaseSnapshot = serde_json::from_str(&text)
        .map_err(|e| format!("file doesn't look like a Loach export: {e}"))?;
    if snap.schema != "loach/v1" {
        return Err(format!(
            "unsupported export schema '{}' — this build expects 'loach/v1'",
            snap.schema
        ));
    }
    state.db.restore_snapshot(&snap).map_err(err)
}

/// Archive every non-archived session in one go. The Rust side returns
/// the number of rows it actually flipped so the UI can say "Archived 8
/// chats" vs. "Nothing to archive".
#[tauri::command]
pub async fn archive_all_sessions(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.archive_all_sessions().map_err(err)
}

/// Delete chats / spaces / snippets / MCP servers but leave app
/// settings (theme, provider URLs, system prompt, etc.) intact. The
/// OpenAI key — which lives in the OS credential manager, not SQLite —
/// also survives. Use [`factory_reset`] for the nuclear option.
#[tauri::command]
pub async fn wipe_user_data(state: State<'_, AppState>) -> Result<(), String> {
    state.db.wipe_user_data().map_err(err)
}

/// Factory reset: wipe_user_data + drop all settings + clear the stored
/// OpenAI key. After this the app should look exactly like a fresh
/// install, save for the DB file itself (which is empty but preserved).
#[tauri::command]
pub async fn factory_reset(state: State<'_, AppState>) -> Result<(), String> {
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
