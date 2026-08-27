mod commands;
mod db;
mod mcp;
mod ollama_launch;
mod preload;
mod providers;
mod secrets;
mod security;
mod sse;
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
    /// Cached MCP tool catalogue so each chat send doesn't re-handshake
    /// every enabled server. Invalidated on MCP config changes and restores.
    pub mcp_tools_cache: crate::mcp::ToolsCache,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tracing defaults differ by build mode. Release builds default to `warn`
    // so a packaged app's stderr (which a sysadmin can capture via console
    // redirect on Windows or `journalctl` on Linux) is signal-rich and noise-
    // free; debug builds default to chatty `info,loach_lib=debug` so a dev
    // running `npm run tauri:dev` sees everything. `RUST_LOG=…` always wins
    // when set, so support can still ask a user to "run with RUST_LOG=debug"
    // to capture full traces for a bug report.
    let default_filter = if cfg!(debug_assertions) {
        "info,loach_lib=debug"
    } else {
        "warn,loach_lib=warn"
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| default_filter.into()),
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

            // Notes on the builder config:
            //   - We DON'T call `.http2_prior_knowledge()`. HTTP/2 negotiates
            //     via TLS ALPN with rustls-tls — every hosted provider we
            //     talk to (OpenAI, Anthropic, OpenRouter, Groq, Together, …)
            //     supports it and gets multiplexing for free; cleartext
            //     endpoints (local Ollama on http://127.0.0.1) stay on
            //     HTTP/1.1, which is what they want.
            //   - `gzip` / `brotli` only decompress when the server actually
            //     sets `Content-Encoding`. SSE chat streams typically don't
            //     compress, so this is a no-op for the hot streaming path;
            //     non-streamed admin responses (model lists etc.) shrink.
            //   - `connect_timeout` applies to the TCP+TLS handshake only,
            //     not the response body — long generations still work
            //     because the chat stream's body has no client-side cap.
            //   - `tcp_keepalive` keeps idle pooled connections alive so a
            //     burst of admin calls reuses the same socket.
            //   - `redirect(none)` is a deliberate SSRF guard. Providers call
            //     `refuse_link_local_host` on the *configured* base URL, but
            //     that check can't see a 30x redirect — a hosted (or
            //     compromised) endpoint could otherwise bounce a request to
            //     `http://169.254.169.254/…` (cloud metadata) and reqwest
            //     would follow it by default. No real LLM API redirects its
            //     endpoints, so refusing outright is safe; the MCP and
            //     web-fetch paths already disable redirects on their own
            //     pinned clients (`build_pinned_client`).
            let http = match reqwest::Client::builder()
                .user_agent(concat!("Loach/", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(10))
                .tcp_keepalive(Some(std::time::Duration::from_secs(30)))
                .pool_max_idle_per_host(8)
                .build()
            {
                Ok(c) => c,
                Err(e) => fatal_setup_error(
                    handle,
                    "the HTTP client couldn't be initialised (TLS or root certs may be missing)",
                    e,
                ),
            };

            // Hold on to clones of the DB handle and HTTP client BEFORE
            // moving them into `AppState` so the speculative-preload task
            // below doesn't need to fish them back out of managed state.
            // Both types are cheap to clone — `Arc` bumps a refcount, and
            // `reqwest::Client` is internally `Arc`-shared too.
            let db = Arc::new(db);
            let preload_db = db.clone();
            let preload_http = http.clone();

            let state = AppState {
                db,
                http,
                streams: StreamRegistry::new(),
                mcp_tools_cache: crate::mcp::new_tools_cache(),
            };
            app.manage(state);

            // Speculative VRAM warming. Fires only when the user opted in
            // via "preload default model" AND no app-lock is configured;
            // otherwise the post-unlock JS preload in `App.tsx` covers it.
            // This call returns immediately — the actual `/api/chat` to
            // Ollama runs on a background task, so a slow / unreachable
            // Ollama can never extend startup time. See `preload.rs` for
            // the full rationale and the JS/Rust handoff story.
            preload::try_warm_default_model(preload_db, preload_http);

            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show Loach", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            // macOS menu-bar icons render as template images — single-channel
            // masks taken from the alpha channel — so they auto-invert in
            // light vs. dark menu bars. The flag is a no-op on Windows /
            // Linux, but we still gate it so the intent reads clearly.
            let _tray = {
                let builder = TrayIconBuilder::with_id("loach-tray")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Loach");
                // `default_window_icon()` is Some in any normal bundled build,
                // but guard rather than `unwrap()` so a packaging slip that
                // ships without the icon degrades to an icon-less tray instead
                // of panicking the whole `setup` (which would bypass the
                // friendly `fatal_setup_error` dialog the rest of setup uses).
                let builder = match app.default_window_icon() {
                    Some(icon) => builder.icon(icon.clone()),
                    None => builder,
                };
                #[cfg(target_os = "macos")]
                let builder = builder.icon_as_template(true);
                builder
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
                .build(app)?
            };

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sessions,
            commands::create_session,
            commands::rename_session,
            commands::pin_session,
            commands::archive_session,
            commands::delete_session,
            commands::fork_session,
            commands::update_session_model,
            commands::update_session_system_prompt,
            commands::update_session_params,
            commands::update_session_label,
            commands::set_session_folder,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::export_session,
            commands::list_messages,
            commands::session_message_counts,
            commands::search_messages,
            commands::append_message,
            commands::import_messages,
            commands::delete_import_group,
            commands::update_message,
            commands::delete_message,
            commands::pin_message,
            commands::clear_session_messages,
            commands::mark_messages_compacted,
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
            commands::ollama_start,
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
            commands::list_snippet_variables,
            commands::create_snippet_variable,
            commands::update_snippet_variable,
            commands::delete_snippet_variable,
            commands::list_snippet_fill_values,
            commands::upsert_snippet_fill_values,
            commands::fetch_url,
            commands::mcp_list,
            commands::mcp_save,
            commands::mcp_delete,
            commands::mcp_test,
            commands::storage_stats,
            commands::export_data_json,
            commands::import_data_with_dialog,
            commands::save_text_to_file,
            commands::save_binary_to_file,
            commands::archive_all_sessions,
            commands::delete_archived_sessions,
            commands::wipe_user_data,
            commands::factory_reset,
            commands::updater_supported,
            commands::open_in_vscode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loach");
}
