# Loach — agent guide

Native local LLM chat client for Windows + Linux. Tauri 2 shell, React/Vite/TS
frontend, Rust backend. See `README.md` for user-facing docs.

## Stack at a glance

- **Frontend**: React 18 + Vite + TypeScript, Tailwind + shadcn/ui, Zustand,
  `react-markdown` + `rehype-highlight`, `lucide-react` icons.
- **Backend**: Tauri 2, `rusqlite` (bundled), `reqwest` streaming, `keyring`
  for OS-level secret storage, `tokio` async.
- **Build targets**: `.msi`/`.exe` (Windows), `.deb`/`.AppImage` (Linux).

## Layout

```
src/
  App.tsx                 Main shell — TitleBar / Sidebar / ChatHeader / ChatCanvas / ChatInput / ParameterPanel / SettingsDialog
  main.tsx                React entry
  types.ts                Shared TS types (Session, Message, ChatRequest, ...)
  styles/globals.css      Tailwind base + theme tokens
  lib/
    tauri.ts              Thin invoke()/listen() wrappers — single source of truth for backend calls
    files.ts              File-to-Attachment, 15 MB cap, text inlining, base64 imaging
    export.ts             Chat export → JSON / Markdown via dialog.save()
    utils.ts              cn(), formatBytes, relativeDay
  stores/
    chatStore.ts          Sessions / messages / streaming state machine
    settingsStore.ts      Provider URLs, theme, OpenAI key status, global system prompt
    uiStore.ts            Sidebar / params / settings open flags
  components/
    TitleBar.tsx          Frameless drag region + min/max/close buttons (close hides to tray)
    Sidebar.tsx           Grouped session list (today/yesterday/week/older) + actions menu
    ChatHeader.tsx        Model dropdown (Ollama + OpenAI) with Ollama status badge
    ChatCanvas.tsx        Auto-scrolling message list, sticks to bottom unless user scrolls up
    Message.tsx           User / assistant / system bubble + inline metrics
    Markdown.tsx          react-markdown wrapper, code blocks delegate to CodeBlock
    CodeBlock.tsx         Syntax-highlighted code with "Copy" button
    ChatInput.tsx         Auto-grow textarea, attach button, global drag-and-drop overlay, Enter to send
    FileChip.tsx          Attached file preview chip
    ParameterPanel.tsx    Right drawer: temperature/top_p/max_tokens/freq/presence/num_ctx + per-chat system prompt
    SettingsDialog.tsx    Tabs: Providers / System prompt / Appearance
    ui/                   shadcn primitives (button, dialog, dropdown-menu, slider, scroll-area, ...)

src-tauri/
  Cargo.toml              Rust deps (tauri 2, reqwest, rusqlite, keyring, tokio)
  tauri.conf.json         Frameless window config, tray icon, bundle targets
  capabilities/default.json  Window/dialog/fs permissions
  src/
    main.rs               Binary entry → loach_lib::run()
    lib.rs                App setup, AppState, system tray, window event hooks, command registration
    db.rs                 SQLite schema + CRUD (sessions, messages, settings)
    secrets.rs            keyring wrapper for OpenAI API key
    stream.rs             StreamRegistry for cancellation; StreamEvent enum
    commands.rs           #[tauri::command] surface (sessions, messages, settings, providers, chat_stream/cancel)
    providers/
      mod.rs              ChatRequest / GenerationParams / ModelInfo / ChatMessageIn types
      ollama.rs           probe(), list_models(), unload_model() (keep_alive=0), chat_stream() NDJSON
      openai.rs           list_models(), chat_stream() SSE, vision via image_url+base64
```

## Streaming model

`commands::chat_stream` spawns a Tokio task and immediately returns a
`stream_id`. Tokens / metrics / done / error are emitted as events on the
channel `chat://<stream_id>` via `app_handle.emit()`. The frontend subscribes
with `listen()` in `lib/tauri.ts::startChatStream`. Cancellation is wired
through a `tokio::sync::Notify` stored in `StreamRegistry` and reached by the
`chat_cancel` command.

This keeps the UI thread free during long generations (non-functional req #1
in `Loach.pdf`).

## Switching models / unloading VRAM

When the user picks a new model in `ChatHeader`, `chatStore::setSessionModel`
calls `ollama_unload_model` for the previous model with `keep_alive: 0`. The
new generation request also passes `keep_alive` implicitly through Ollama
options.

## File handling

`lib/files.ts` enforces the 15 MB cap. Images become base64 strings sent via
`messages[].images` for Ollama or `image_url` data URIs for OpenAI. Text
files (`.txt`/`.md`/`.csv`/`.json`/`.log`) are inlined as fenced context
blocks at the end of the user message via `inlineTextAttachments`.

## Secrets

Never log or persist the OpenAI key in SQLite. The Rust side uses `keyring`
which maps to Windows Credential Manager and Linux Secret Service. The
frontend only ever sees a boolean `openai_key_set` status.

## Theming

Tailwind dark mode via the `dark` class on `<html>`. Theme is `dark` by
default; `system` honors `prefers-color-scheme`. Tokens are HSL CSS variables
in `styles/globals.css`.

## Adding a new Tauri command

1. Add the function with `#[tauri::command]` in `src-tauri/src/commands.rs`.
2. Register it in `lib.rs::run()` inside `tauri::generate_handler![...]`.
3. Expose a typed wrapper in `src/lib/tauri.ts`.
4. Add any new permissions to `src-tauri/capabilities/default.json` if it
   uses a plugin (`fs`, `dialog`, `shell`, `core:window:*`).

## Testing checklist (manual)

See the verification list in `README.md` and the original plan. Critical
end-to-end paths:

- Offline launch with Ollama running locally.
- Streamed reply with telemetry.
- Model swap unloads previous model (`ollama ps`).
- OpenAI key persists across restart and isn't in `loach.db`.
- 15 MB file rejection; image attachment to a vision model.
- Frameless titlebar drag, minimize, maximize, close→tray, tray→Quit.
- Code blocks render with highlighting and "Copy" copies to clipboard.

## Conventions

- Keep `lib/tauri.ts` the only place that calls `invoke()` / `listen()`.
- Components are pure presentation; all mutable state lives in Zustand stores.
- Don't add extra abstractions for hypothetical providers — add a new
  `providers/<name>.rs` file with `chat_stream()` and `list_models()` and a
  match arm in `commands::chat_stream`.
- Don't write the OpenAI key into Zustand or SQLite; only `openai_key_set: bool`.
