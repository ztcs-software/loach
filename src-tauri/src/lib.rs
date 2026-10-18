mod commands;
mod db;
mod gpu;
mod mcp;
mod ollama_launch;
mod preload;
mod providers;
mod rag;
mod sandbox;
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
    /// Per-call tool approvals parked by the provider loop and answered by
    /// `tool_approval_respond`.
    pub approvals: crate::stream::ApprovalRegistry,
    /// stdio MCP command lines the user confirmed in the native consent
    /// dialog this session (keyed by `McpServer::stdio_fingerprint`), so a
    /// test-then-save asks once. Deliberately not persisted: a fresh
    /// process re-asks before anything runs.
    pub stdio_approved: parking_lot::Mutex<std::collections::HashSet<String>>,
    /// Background worker keeping the Library / Space-source retrieval index
    /// chunked and embedded. Woken by anything that can create work.
    pub indexer: Arc<rag::indexer::Indexer>,
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
        .register_uri_scheme_protocol(sandbox::SCHEME, |_ctx, request| sandbox::handle(&request))
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
            let indexer = rag::indexer::Indexer::spawn(handle.clone(), db.clone(), http.clone());

            let state = AppState {
                db,
                http,
                streams: StreamRegistry::new(),
                mcp_tools_cache: crate::mcp::new_tools_cache(),
                approvals: crate::stream::ApprovalRegistry::new(),
                stdio_approved: Default::default(),
                indexer,
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
            // light vs. dark menu bars. That rules out the app icon there: it
            // is an opaque rounded square, so its mask is a solid blob. macOS
            // gets `icons/tray-template.png` instead, the fish line art in
            // black on transparent. It is 36 px tall because tray-icon draws
            // the image 18 pt tall, so it maps 2:1 onto a Retina menu bar.
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
                #[cfg(not(target_os = "macos"))]
                let builder = match app.default_window_icon() {
                    Some(icon) => builder.icon(icon.clone()),
                    None => builder,
                };
                #[cfg(target_os = "macos")]
                let builder = builder
                    .icon(tauri::include_image!("icons/tray-template.png"))
                    .icon_as_template(true);
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

            // macOS: closing the window (red button, ⌘W) hides it and Loach
            // stays in the Dock, like other Mac apps; the Dock icon (the
            // `Reopen` arm below) or the tray brings it back. ⌘Q and the
            // tray's Quit still quit — they end the app without a close
            // request. Windows and Linux keep close-means-quit.
            #[cfg(target_os = "macos")]
            {
                use tauri::Emitter;
                if let Some(window) = app.get_webview_window("main") {
                    let w = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            // Closing used to quit, and every launch meets the
                            // app lock; the renderer locks on this when one is
                            // set (`useAutoLock`), so a close still locks.
                            let _ = w.emit("window://close-hidden", ());
                            if w.is_fullscreen().unwrap_or(false) {
                                // Hiding a full-screen window leaves its Space
                                // behind, empty and black. Hiding the app (⌘H)
                                // steps out of the Space properly.
                                let _ = w.app_handle().hide();
                            } else {
                                let _ = w.hide();
                            }
                        }
                    });
                }
            }

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
            commands::pick_session_workspace,
            commands::clear_session_workspace,
            commands::open_session_workspace,
            commands::read_workspace_instructions,
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
            commands::system_info,
            commands::ollama_list_models,
            commands::ollama_probe,
            commands::ollama_start,
            commands::openai_list_models,
            commands::chat_stream,
            commands::chat_cancel,
            commands::chat_cancel_all,
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
            commands::list_global_memories,
            commands::add_global_memory,
            commands::update_global_memory,
            commands::remove_global_memory,
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
            commands::library_list,
            commands::library_get_items,
            commands::library_create_item,
            commands::library_rename_item,
            commands::library_update_text,
            commands::library_add_link,
            commands::library_refresh_link,
            commands::library_delete_items,
            commands::library_usage,
            commands::library_create_dataset,
            commands::library_update_dataset,
            commands::library_set_dataset_items,
            commands::library_delete_dataset,
            commands::library_list_sources,
            commands::library_add_sources,
            commands::library_remove_source,
            commands::library_set_source_enabled,
            commands::set_space_file_enabled,
            commands::set_space_retrieval_mode,
            commands::set_session_retrieval_mode,
            commands::rag_search,
            commands::rag_status,
            commands::rag_reindex,
            commands::mcp_list,
            commands::mcp_save,
            commands::mcp_delete,
            commands::mcp_test,
            commands::mcp_tools,
            commands::tool_approval_respond,
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
        .build(tauri::generate_context!())
        .expect("error while building Loach")
        .run(|_app, event| match event {
            tauri::RunEvent::Exit => {
                // Pooled stdio MCP servers are our child processes. Kill
                // them now rather than rely on each one noticing its stdin
                // closing once we're gone.
                crate::mcp::drop_all_sessions();
                crate::mcp::stdio::kill_all_now();
            }
            // A Dock click while the window is hidden to the tray. macOS
            // brings back minimized windows itself, but not hidden ones, so
            // without this the click did nothing.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Some(w) = _app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    /// macOS draws the tray icon as a template, from the alpha channel alone
    /// and 18 pt tall, so the file must stay black on transparent and 36 px
    /// (2x) tall. Off macOS this is also the only place the `include_image!`
    /// path is compiled.
    #[test]
    fn tray_template_is_a_retina_menu_bar_template() {
        let icon = tauri::include_image!("icons/tray-template.png");
        assert_eq!(icon.height(), 36);
        assert!(icon.rgba().chunks(4).all(|px| px[..3] == [0, 0, 0]));
        assert!(icon.rgba().chunks(4).any(|px| px[3] == 255));
    }
}
