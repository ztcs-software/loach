mod commands;
mod db;
mod mcp;
mod providers;
mod secrets;
mod security;
mod stream;
mod tools;

use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::db::Database;
use crate::stream::StreamRegistry;

/// Show a blocking native error dialog and exit. Used during `setup` for
/// failures we can't reasonably recover from (data dir unresolvable, DB
/// corrupt, etc.) — much friendlier than the prior `panic!` which left
/// the user staring at a closed app and no explanation. Falls back to
/// stderr if the dialog itself can't be shown.
fn fatal_setup_error(app: &tauri::AppHandle, what: &str, err: impl std::fmt::Display) -> ! {
    let body = format!(
        "Loach can't start because {what}.\n\nDetails: {err}\n\n\
         If this keeps happening, please file an issue with the details above."
    );
    eprintln!("[fatal] {what}: {err}");
    // `blocking_show` returns once the user clicks "OK". On platforms where
    // the dialog can't be shown (very headless CI, broken display) this
    // returns immediately — we still exit afterwards so the app doesn't
    // limp on with broken state.
    let _ = app
        .dialog()
        .message(&body)
        .title("Loach failed to start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1);
}

pub struct AppState {
    pub db: Arc<Database>,
    pub http: reqwest::Client,
    pub streams: StreamRegistry,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,loach_lib=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Replace the prior `.expect(...)` chain with explicit user-
            // facing error dialogs. The old behaviour silent-crashed the
            // app whenever the data dir was unresolvable, the DB file was
            // corrupt, or a migration tripped over a half-written schema —
            // the user just saw the window never appear.
            let handle = app.handle();

            let data_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => fatal_setup_error(
                    handle,
                    "the app data directory couldn't be resolved",
                    e,
                ),
            };
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                fatal_setup_error(
                    handle,
                    &format!(
                        "the app data directory ({}) couldn't be created",
                        data_dir.display()
                    ),
                    e,
                );
            }

            let db_path = data_dir.join("loach.db");
            let db = match Database::open(&db_path) {
                Ok(d) => d,
                Err(e) => fatal_setup_error(
                    handle,
                    &format!("the database at {} couldn't be opened", db_path.display()),
                    e,
                ),
            };
            if let Err(e) = db.migrate() {
                fatal_setup_error(
                    handle,
                    "the database schema migration failed",
                    e,
                );
            }

            let http = match reqwest::Client::builder().user_agent("Loach/0.1").build() {
                Ok(c) => c,
                Err(e) => fatal_setup_error(
                    handle,
                    "the HTTP client couldn't be initialised (TLS or root certs may be missing)",
                    e,
                ),
            };

            let state = AppState {
                db: Arc::new(db),
                http,
                streams: StreamRegistry::new(),
            };
            app.manage(state);

            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show Loach", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("loach-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Loach")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sessions,
            commands::create_session,
            commands::rename_session,
            commands::pin_session,
            commands::archive_session,
            commands::delete_session,
            commands::update_session_model,
            commands::update_session_system_prompt,
            commands::update_session_params,
            commands::export_session,
            commands::list_messages,
            commands::append_message,
            commands::update_message,
            commands::get_settings,
            commands::set_setting,
            commands::set_openai_key,
            commands::get_openai_key_status,
            commands::clear_openai_key,
            commands::security_status,
            commands::security_setup,
            commands::security_unlock,
            commands::security_get_hint,
            commands::security_clear,
            commands::ollama_list_models,
            commands::ollama_probe,
            commands::openai_list_models,
            commands::chat_stream,
            commands::chat_cancel,
            commands::ollama_unload_model,
            commands::ollama_preload_model,
            commands::ollama_show_model,
            commands::ollama_delete_model,
            commands::ollama_copy_model,
            commands::ollama_pull_model,
            commands::ollama_create_model,
            commands::admin_cancel,
            commands::list_spaces,
            commands::get_space,
            commands::create_space,
            commands::update_space,
            commands::delete_space,
            commands::list_space_files,
            commands::add_space_file,
            commands::remove_space_file,
            commands::get_space_context,
            commands::list_space_memories,
            commands::add_space_memory,
            commands::update_space_memory,
            commands::remove_space_memory,
            commands::list_snippets,
            commands::create_snippet,
            commands::update_snippet,
            commands::delete_snippet,
            commands::fetch_url,
            commands::mcp_list,
            commands::mcp_save,
            commands::mcp_delete,
            commands::mcp_test,
            commands::export_data_json,
            commands::import_data_with_dialog,
            commands::save_text_to_file,
            commands::archive_all_sessions,
            commands::wipe_user_data,
            commands::factory_reset,
            commands::updater_supported,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loach");
}
