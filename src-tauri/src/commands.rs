use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::db::{Message, Session, Snippet, Space, SpaceFile};
use crate::providers::{self, ChatRequest, ModelInfo};
use crate::secrets;
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
}

#[tauri::command]
pub async fn update_space(
    state: State<'_, AppState>,
    args: UpdateSpaceArgs,
) -> Result<(), String> {
    state
        .db
        .update_space(&args.id, &args.name, &args.description, &args.instructions)
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
    Ok(SpaceContext { space, files })
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
