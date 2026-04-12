mod commands;
mod db;
mod providers;
mod secrets;
mod stream;

use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

use crate::db::Database;
use crate::stream::StreamRegistry;

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
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Resolve app data dir and open the database there.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("loach.db");
            let db = Database::open(&db_path).expect("failed to open SQLite database");
            db.migrate().expect("failed to run migrations");

            let state = AppState {
                db: Arc::new(db),
                http: reqwest::Client::builder()
                    .user_agent("Loach/0.1")
                    .build()
                    .expect("reqwest client"),
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
        .on_window_event(|window, event| {
            // Hide to tray instead of closing when the user clicks the X.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sessions,
            commands::create_session,
            commands::rename_session,
            commands::delete_session,
            commands::export_session,
            commands::list_messages,
            commands::append_message,
            commands::update_message,
            commands::get_settings,
            commands::set_setting,
            commands::set_openai_key,
            commands::get_openai_key_status,
            commands::clear_openai_key,
            commands::ollama_list_models,
            commands::ollama_probe,
            commands::openai_list_models,
            commands::chat_stream,
            commands::chat_cancel,
            commands::ollama_unload_model,
            commands::list_spaces,
            commands::get_space,
            commands::create_space,
            commands::update_space,
            commands::delete_space,
            commands::list_space_files,
            commands::add_space_file,
            commands::remove_space_file,
            commands::get_space_context,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loach");
}
