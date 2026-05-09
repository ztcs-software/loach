<div align="center">

# Loach

**A native, local-first chat client for LLMs.**

Run [Ollama](https://ollama.com) and any OpenAI-compatible endpoint side-by-side, with a focused desktop UX, offline-first design, and your data living entirely on your own machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)

</div>

---

## What is Loach?

Loach is a desktop chat client for large language models, designed for developers and power users who want a polished native UI without giving up control over their data. It pairs a Tauri 2 (Rust) shell with a React/Vite/TypeScript frontend, talks to a local Ollama server out of the box, and accepts any OpenAI-compatible endpoint as a second provider — vLLM, LM Studio, LiteLLM, llama.cpp's `llama-server`, OpenRouter, Groq, Mistral, Together, Fireworks, and so on.

Everything is local: chats, attachments, settings, generation parameters, and snippet libraries live in a SQLite database under your OS-managed app data directory. API keys live in your OS credential manager (Windows Credential Manager / Linux Secret Service via `keyring`), never in plaintext. There is no telemetry, no auto-update ping, and no required network access at startup beyond probing your local Ollama server.

---

## Features

### Chat

- **Streaming responses** — token-by-token over Tauri events emitted from a Tokio task; the UI thread stays responsive even on long generations.
- **Generation telemetry** — inline `tok/s · total tokens · elapsed` under each assistant turn.
- **Per-chat parameters** — temperature, top-P, top-K, min-P, max tokens, context length, repeat / frequency / presence penalties, seed, and a per-chat system-prompt override. Defaults layer: app defaults → Modelfile defaults → per-model preferences → per-chat overrides, in that order.
- **Thinking / reasoning** — a Thinking toggle (request-time `think` parameter) for Ollama models that advertise the capability (Qwen3, DeepSeek-R1, GPT-OSS, …). Per-chat in the parameter sidebar, per-model default in the model editor, gated automatically on the model's `/api/show` `capabilities`.
- **Markdown rendering** — full GitHub-flavoured Markdown with `react-markdown` + `remark-gfm`. Inline code is a translucent chip; tables are scannable with header tint, zebra rows, and visible borders; LaTeX-style symbol fallback (`\to`, `\alpha`, `\sum`, …) without pulling in a full math stack.
- **Code blocks** — syntax highlighting via `highlight.js` (`github-dark`), line numbers, **Copy** to clipboard, **Export** with the right file extension (`.py`, `.ts`, `.html`, `.rs`, `.go`, `.cpp`, `.cs`, `.rb`, `.sh`, `.ps1`, `.sql`, `.md`, ~40 known languages), and **Open in canvas**.
- **Code Canvas** — right-side panel that opens any code block in a wider workspace with its own toolbar (Copy, Export). Theme-aware fill so the canvas matches the active background variant.
- **Expandable user prompts** — long pasted prompts clamp to ~10 lines with a *Show more / Show less* toggle.
- **Scroll-to-bottom button** — appears when you scroll up >200 px during streaming, smooth-scrolls back.
- **Stop / queue** — generation runs one task at a time across the whole app. Other chats queue up in a global FIFO and get a "Waiting for other chats to finish…" banner with **Respond now** (interrupt the runner and promote this chat) and **Cancel** options.
- **Per-chat actions** — Search in chat, Pin / Unpin, Rename, Move to / Restore from archive, Delete, Export context (JSON / Markdown), Import context (paste an exported chat or any text — auto-detects JSON, Markdown, plain).
- **Activity indicators** — sidebar chat tiles show an animated spinner while a chat is generating and an accent dot when an assistant reply finishes on a chat the user wasn't viewing. Clearing on open.

### Inputs and attachments

- **Drag-and-drop** anywhere in the chat surface. The composer bar gets a drop-zone highlight that respects light / dark themes.
- **20 MB cap** per file with a clear inline error. Spaces additionally cap total attached files at **200 MB**.
- **Images** — base64-encoded and routed to vision-capable models (LLaVA, Llama 3.2 Vision, GPT-4o family).
- **Text & docs** — `.txt`, `.md`, `.csv`, `.json`, `.log`, `.pdf` (via `pdfjs-dist`), `.docx` (via `mammoth`). Extracted text is appended to the user message as a fenced context block with a clear filename header.
- **Web fetch** — toggle in **Settings → Providers**: when enabled, URLs in your message are auto-fetched, sanitized, and inlined as context. Capped at 3 URLs / message, 5 MB / page, 15 s timeout. Private IPs and localhost are blocked.
- **Temporal awareness** — optional injection of current date / time / weekday / timezone into every system prompt so models can answer "what day is it today?". Template variables let you place the values precisely.

### Spaces, Snippets, Models — three full-canvas libraries

- **Spaces** — group chats around a project. Each Space has its own instructions, reference files (drop in `.md`, `.pdf`, etc.), and a chat history scoped to it. Tiles show a chat count, "Instructions" badge if customised, and last-updated timestamp. Click a tile to open the Space; **New chat** button starts a fresh conversation already inside the Space.
- **Snippets** — reusable prompts. Each tile carries a 4-line preview, a pinned-model chip (provider + model), and a prominent **Run** button that creates a fresh chat with the prompt pre-filled and (optionally) the right model already selected.
- **Models** — manage your local Ollama models: pull new tags, copy / duplicate, delete, customise (edit Modelfile system prompt / parameters / template, save as a new derived model). OpenAI catalog is shown read-only. Live progress chips for in-flight pulls / creates with cancel support.

### Sidebar

- **Single-column ChatGPT-style layout** with a thin always-visible rail when collapsed.
- **New chat** button with a hover dropdown that also exposes *New space* / *New snippet* — click always starts a new chat; the dropdown is purely a hover-revealed extra.
- **Quicklinks** for Search, Spaces, Snippets, Models.
- **Chat history grouped** by `Pinned`, `Today`, `Yesterday`, `This week`, `Older`.
- **Per-chat right-click menu** (Pin / Rename / Export / Archive / Delete).
- **Settings** pinned at the bottom.

### Search

- **Global Cmd+K palette** — floating overlay above any surface. Searches chats, spaces, and snippets simultaneously. Up/down to navigate, Enter to commit, Esc to close.
- **In-chat finder** — browser-style top-right overlay, scoped to the current chat's messages. Inline phrase highlighting (matches wrapped in `<mark>` with theme accent), `↑` / `↓` navigation, Esc closes. Two-step Esc clears the query first, then closes.

### Security

- **App lock** — optional PIN, password, or PIN + password gate at launch. PIN length 4 / 6 / 8. Optional hint shown on the lock screen behind a *Show hint* button. Credentials hashed with **argon2id** + per-credential salt; the hash blob lives in the OS credential manager, never in SQLite.
- **API keys in keyring** — OpenAI keys go through `keyring` (Windows Credential Manager / Linux Secret Service). The frontend only sees a `key_set: bool` status, never the plaintext.

### Visual

- **Theme-aware accent colour** — azure (`#007FFF`) in light mode, orange (`#F96610`) in dark mode. Applies across both background variants.
- **Two background variants** — *Aurora* (animated gradient mesh) and *Solid* (flat single-colour).
- **Glass / flat surfaces** — translucent cards on Aurora, solid surfaces on Solid. Switches and dropdowns auto-pick the right variant.
- **Theme-aware logo** — black mark in light mode, orange mark in dark mode. CSS-only swap, no JS re-render on theme change.
- **Frameless window** — custom title bar with sidebar toggle, brand + version label, and platform-aware window controls (red X on Windows, muted on Linux). Drag region works across the whole bar.
- **Minimize to system tray** — close-button hides the window; tray icon left-click toggles visibility; tray menu has Show / Hide / Quit.

### Backend & integrations

- **Two providers out of the box** — Ollama (auto-detected on `http://localhost:11434`) and OpenAI-compatible (configurable base URL, e.g. vLLM, LM Studio, LiteLLM, llama-server, OpenRouter, Groq).
- **MCP support** — register Model Context Protocol servers (Streamable HTTP transport) and let your local model call their tools mid-chat. Per-server enable toggle, "Test connection" handshake, JSON-RPC client built into the Rust side.
- **Web fetch tool** — built-in server-side URL fetcher with size, count, and timeout caps; private-IP guard.
- **Data import / export** — back up everything (chats, messages, spaces, snippets, MCP servers, app settings) to a single JSON file, or restore from one. API keys are deliberately excluded — they stay in keyring across operations.
- **Model VRAM management** — switching models mid-app sends `keep_alive: 0` for the previous Ollama model to free GPU memory before the next load.

---

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri 2.x (Rust) |
| Frontend | React 18 + Vite 5 + TypeScript |
| Styling | Tailwind CSS + shadcn/ui (Radix primitives) + `tailwindcss-animate` + `@tailwindcss/typography` |
| Icons | `lucide-react` |
| State | Zustand (in-memory; backed by SQLite for persistence where appropriate) |
| Storage | SQLite via `rusqlite` (bundled feature — no system dependency) |
| Secrets | `keyring` crate → Windows Credential Manager / Linux Secret Service |
| Argon2id | `argon2` + `rand_core` (for app-lock hashing) |
| HTTP | `reqwest` with streaming + `rustls-tls` |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` (highlight.js) |
| Document parsing | `pdfjs-dist` (PDF) + `mammoth` (DOCX) |
| System tray | Tauri 2 built-in (`tray-icon` feature) |
| Bundle targets | `.msi` / `.exe` (NSIS) on Windows; `.deb` / `.AppImage` on Linux |

---

## Prerequisites

- **Node.js 20+** and **npm**
- **Rust** stable toolchain via [`rustup`](https://rustup.rs)
- Platform build tooling — install once via the official Tauri prerequisites guide: <https://tauri.app/start/prerequisites/>
  - **Windows**: Microsoft Visual Studio Build Tools, WebView2 runtime (preinstalled on Windows 11)
  - **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `libssl-dev`, `pkg-config`, `libsecret-1-dev`

For runtime LLM use you'll typically also want:

- **[Ollama](https://ollama.com/download)** running locally (`ollama serve`)

---

## Getting started

### Clone and install

```bash
git clone https://github.com/<your-org>/loach.git
cd loach
npm install
```

### Run in development

```bash
npm run tauri:dev
```

The Vite dev server runs on `http://localhost:1420` and the Tauri shell embeds it. Hot-reload works for the React side; the Rust side rebuilds when you edit anything under `src-tauri/`.

### Build production installers

```bash
npm run tauri:build
```

Outputs land in `src-tauri/target/release/bundle/`:

- **Windows**: `.msi` (WiX) and `.exe` (NSIS)
- **Linux**: `.deb` and `.AppImage`

> Icon assets live in `src-tauri/icons/`. Regenerate the full set from a 1024×1024 PNG with `npm run tauri icon path/to/source.png`.

### Other scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server only (no Tauri shell — useful for browser-side iteration with mocked backend) |
| `npm run build` | TypeScript typecheck + Vite production build (no Tauri) |
| `npm run preview` | Vite preview server for the production build |
| `npm run tauri` | Pass-through to the Tauri CLI for any subcommand (`info`, `signer`, `migrate`, …) |

---

## First-run setup

### Using Ollama

```bash
ollama serve
ollama pull llama3.1:8b      # or any other tag
```

Loach probes `http://localhost:11434` on launch. Pulled models appear in the chat header dropdown automatically; the **Models** library tab also lets you pull new tags and customise existing ones from inside the app.

### Using OpenAI / OpenAI-compatible endpoints

Open **Settings → Providers**, paste your API key (stored in your OS credential manager), and optionally point the base URL at any compatible endpoint:

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` *(default)* |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| LiteLLM | `http://localhost:4000/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| Groq, OpenRouter, Together, Fireworks, Mistral | per their docs |

Only one OpenAI-compatible endpoint is active at a time — switch base URL in Settings whenever you want to point at a different provider.

### Optional — set up app lock

**Settings → Security**: pick PIN-only, password-only, or PIN + password. Set a hint if you want a recovery cue. The credentials are hashed with argon2id + a per-credential salt and the blob is written to your OS credential manager (Windows Credential Manager / Linux Secret Service). The lock screen mounts before any chat data is hydrated, so chats never paint behind it.

---

## Project structure

```
loach/
├─ src/                         React frontend
│  ├─ App.tsx                   Main shell, routing, lock gate
│  ├─ main.tsx                  React entry, global context-menu suppression
│  ├─ types.ts                  Shared TS types
│  ├─ assets/                   Logo SVGs
│  ├─ styles/globals.css        Tailwind base + theme tokens + glass + drop-zone styling
│  ├─ lib/
│  │  ├─ tauri.ts               Single source of truth for invoke()/listen() calls
│  │  ├─ files.ts               File → attachment, 20 MB per-file / 200 MB per-space caps, text inlining, base64 imaging
│  │  ├─ codeExport.ts          Code-block export: language → extension map + save dialog
│  │  ├─ export.ts              Chat export → JSON / Markdown via Tauri save dialog
│  │  ├─ importContext.ts       Paste-to-import parser (JSON / Markdown / plain text)
│  │  ├─ modelfile.ts           Modelfile builder + parameters parser
│  │  ├─ modelParams.ts         Ollama PARAMETER block → GenerationParams patch
│  │  ├─ temporal.ts            Temporal-awareness preamble + template variables
│  │  ├─ webFetch.ts            URL extraction + inline page fetch
│  │  └─ utils.ts               cn(), formatBytes, relativeDay, relativeTime
│  ├─ stores/
│  │  ├─ chatStore.ts           Sessions, messages, streaming state, queue, unread
│  │  ├─ canvasStore.ts         Code-canvas open state + content
│  │  ├─ mcpStore.ts            MCP server list + per-server toggle
│  │  ├─ modelsStore.ts         Provider model list + per-model defaults / capabilities / think prefs
│  │  ├─ securityStore.ts       App-lock status + setup / unlock actions
│  │  ├─ settingsStore.ts       Provider URLs, theme, background variant, system prompt
│  │  ├─ snippetStore.ts        Snippets library + edit dialog state
│  │  ├─ spaceStore.ts          Spaces + active space + form state
│  │  └─ uiStore.ts             Sidebar / params / settings / search dialog flags
│  └─ components/
│     ├─ TitleBar.tsx           Frameless window chrome + brand + version
│     ├─ Sidebar.tsx            Single-column nav with collapsed-rail variant
│     ├─ ChatHeader.tsx         Model picker + chat actions (search, pin, rename, archive, delete, …)
│     ├─ ChatCanvas.tsx         Auto-scrolling messages + in-chat search overlay
│     ├─ ChatInput.tsx          Composer with attachments, drag-drop, send/stop morph
│     ├─ Message.tsx            User / assistant / system bubble + thinking block + metrics
│     ├─ Markdown.tsx           react-markdown wrapper with TeX symbol fallback
│     ├─ CodeBlock.tsx          Highlighted code with line numbers + Copy / Export / Open-in-canvas
│     ├─ CodeCanvas.tsx         Right-side code workspace
│     ├─ ParameterPanel.tsx     Right drawer — Thinking, Sampling, Length, Repetition, Reproducibility
│     ├─ SettingsDialog.tsx     Tabs: Providers / Prompt / MCP / Appearance / Archive / Data / Security / About
│     ├─ SecurityPanel.tsx      App-lock setup + management
│     ├─ LockScreen.tsx         Full-window unlock surface
│     ├─ McpPanel.tsx           MCP server list + editor
│     ├─ Spaces*, Snippets*, Models* — full-canvas libraries + per-item editors
│     ├─ SearchBar.tsx          Global Cmd+K palette overlay
│     ├─ Logo.tsx               Theme-aware brand mark
│     └─ ui/                    shadcn primitives (button, dialog, dropdown-menu, slider, switch, …)
│
└─ src-tauri/                   Tauri 2 / Rust backend
   ├─ Cargo.toml                Rust deps (tauri 2, reqwest, rusqlite, keyring, argon2, tokio)
   ├─ tauri.conf.json           Frameless window config, tray icon, bundle targets
   ├─ icons/                    App icon set (1024 source + per-platform sizes)
   ├─ capabilities/default.json Window / dialog / fs / shell permissions
   └─ src/
      ├─ main.rs                Binary entry → loach_lib::run()
      ├─ lib.rs                 App setup, AppState, system tray, window events, command registration
      ├─ db.rs                  SQLite schema + migrations + CRUD (sessions, messages, spaces, snippets, mcp, settings)
      ├─ secrets.rs             Keyring wrapper for OpenAI API key
      ├─ security.rs            Argon2id hashing + keyring-backed lock blob
      ├─ stream.rs              StreamRegistry for cancellation; StreamEvent enum
      ├─ commands.rs            #[tauri::command] surface (sessions, messages, settings, providers, chat_stream/cancel, security, …)
      ├─ providers/
      │  ├─ mod.rs              ChatRequest / GenerationParams / ModelInfo / ChatMessageIn types
      │  ├─ ollama.rs           probe(), list_models(), unload_model(), show_model() w/ capabilities, chat_stream() NDJSON
      │  └─ openai.rs           list_models(), chat_stream() SSE, vision via image_url+base64
      ├─ mcp/
      │  ├─ mod.rs              Re-exports + connection probe
      │  ├─ client.rs           Streamable-HTTP JSON-RPC client
      │  └─ types.rs            MCP tool / call types
      └─ tools/
         ├─ mod.rs              Tool registry
         └─ fetch_url.rs        Web-fetch tool (size, count, timeout, private-IP guard)
```

For an architectural overview written for AI coding assistants, see [`CLAUDE.md`](CLAUDE.md).

---

## Storage and privacy

| What | Where |
|---|---|
| Chats, messages, spaces, snippets, MCP servers, app settings | SQLite at `<app-data-dir>/loach.db` |
| OpenAI API key | OS credential manager (Windows Credential Manager / Linux Secret Service) |
| App-lock hash + hint | OS credential manager — same store, separate entry |
| Attached files (images, text) | Inlined into the message at send time; no separate file store |
| App data dir on Windows | `%APPDATA%\dev.loach.app\` |
| App data dir on Linux | `~/.local/share/dev.loach.app/` |

**Loach makes no outbound network calls at startup** other than the Ollama probe to `localhost`. There is no telemetry, no auto-update ping, no analytics. OpenAI calls only happen when you actively send a message to an OpenAI-compatible endpoint.

---

## Offline mode

Loach launches and works completely offline as long as you stick to local providers (Ollama / vLLM / LM Studio / llama.cpp). The **Models** library, **Spaces**, **Snippets**, search, parameter sidebar, app lock, and chat history are all available without network access. Only chat generations against remote endpoints (OpenAI, Groq, OpenRouter, …) need the internet.

---

## License

[MIT](LICENSE) © ZTCS
