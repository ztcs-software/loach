# Loach

Native local LLM chat client for Windows and Linux. Loach speaks to a local
[Ollama](https://ollama.com) instance and any OpenAI-compatible endpoint
(OpenAI itself, vLLM, LM Studio, LiteLLM, ...) and stores all chat history
locally in SQLite.

- **Streaming** token-by-token responses with live tok/s telemetry.
- **Multimodal** image input for vision-capable models (LLaVA, GPT-4o).
- **Drag-and-drop** for `.txt` / `.md` / `.csv` files (15 MB cap).
- **Frameless window** with custom titlebar and minimize-to-tray.
- **Developer controls**: temperature, top-p, max tokens, frequency/presence
  penalties, context length slider, per-chat system prompt overrides.
- **Secure secrets**: OpenAI API key kept in the OS credential manager
  (Windows Credential Manager / Linux Secret Service via `keyring`).

## Stack

React + Vite + TypeScript + Tailwind + shadcn/ui + Zustand on top of a
Tauri 2 (Rust) shell. SQLite via `rusqlite`. Streaming via Tauri events
emitted from Tokio tasks.

## Prerequisites

- **Node 20+** and **npm**
- **Rust** stable toolchain (`rustup`)
- Platform build tooling:
  - **Windows**: Microsoft Visual Studio Build Tools, WebView2 runtime (preinstalled on Win 11)
  - **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`,
    `libssl-dev`, `pkg-config`, `libsecret-1-dev` (for the keyring crate)

Install Tauri prerequisites once with the official guide:
<https://tauri.app/start/prerequisites/>

## Develop

```bash
npm install
npm run tauri:dev
```

The Vite dev server runs on `http://localhost:1420` and the Tauri shell
embeds it.

## Build installers

```bash
npm run tauri:build
```

Outputs land in `src-tauri/target/release/bundle/`:

- **Windows**: `.msi` (WiX) and `.exe` (NSIS)
- **Linux**: `.deb` and `.AppImage`

> Add icon assets under `src-tauri/icons/` (see the README there) before the
> first build, or generate them with `npm run tauri icon path/to/source.png`.

## Using Ollama

```bash
ollama serve
ollama pull llama3.1:8b
```

Loach probes `http://localhost:11434` on launch. Pulled models appear in the
header dropdown automatically.

## Using OpenAI / OpenAI-compatible endpoints

Open **Settings → Providers**, paste your API key (stored in your OS
credential manager) and optionally point the base URL at any compatible
endpoint, e.g.:

- vLLM: `http://localhost:8000/v1`
- LM Studio: `http://localhost:1234/v1`
- LiteLLM: `http://localhost:4000/v1`

## Offline mode

Loach launches and works completely offline as long as you stick to local
providers. There is no telemetry, no auto-update ping, and no required
network access at startup.

## Project layout

```
src/                React frontend (components, stores, lib)
src-tauri/src/      Rust backend (db, providers, commands, streaming)
```

See `CLAUDE.md` for an architectural overview written for AI coding assistants.

## License

MIT.
