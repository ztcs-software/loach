<div align="center">

# Loach

**A native, local-first AI workspace for desktops**

Run local LLMs with [Ollama](https://ollama.com) or connect any OpenAI-compatible API endpoint side-by-side, with a focused UX, local-first design, native apps for Windows, Linux and macOS, and simple yet powerful features out of the box.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[![Latest release](https://img.shields.io/github/v/release/ztcs-software/loach?label=release)](https://github.com/ztcs-software/loach/releases)
[![Release build](https://github.com/ztcs-software/loach/actions/workflows/release.yml/badge.svg)](https://github.com/ztcs-software/loach/actions/workflows/release.yml)

![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Rust 1.88+](https://img.shields.io/badge/Rust-1.88+-000000?logo=rust&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38BDF8?logo=tailwindcss&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-compatible-000000?logo=ollama&logoColor=white)

</div>

---

## 🔭 Overview

Loach is an all-in-one desktop AI workspace built around a single idea: talking to an LLM should feel effortless. Simple from the first click and ready to grow with you as your needs do. It talks to a local Ollama server and accepts any OpenAI-compatible endpoint as a provider, including llama.cpp, LM Studio, vLLM and LiteLLM.

With local models, including Qwen, Gemma, DeepSeek, GPT-OSS and Mistral, all your data stays safe and private. There is no telemetry, no required network access, no paid subscriptions or usage limits. Optional API keys live in your OS credential manager. 

Behind a calm, beautifully crafted UI sits a rich feature set - ready when you need it, out of the way when you don't. 

![Loach UI](docs/images/loach-ui.png)

---

## ✨ Features

#### Providers & models
- **Provider selection** - switch between Ollama local models and any OpenAI-compatible endpoint (OpenAI API, llama.cpp, LM Studio etc.) from the chat header.
- **Local model management** - pull, copy, customize and delete local models from inside the app. 
- **Start Ollama from Loach** - launch the Ollama server from the model picker when it isn't running, or have Loach start it for you at launch (opt-in).
- **Default model selector** - pick a model new chats open with, per provider - no need to re-select on each fresh conversation.
- **Model preloading** - optionally warm your default local model into VRAM at launch so the first message streams faster. 
- **Per-chat parameters** - set temperature, top_k, top_p, min_p, max tokens, context length, per-chat system prompts and more. Layered over Modelfile and per-model defaults.
- **Low VRAM mode** - global or per-chat toggle that sends Ollama's `low_vram` flag to every request. Useful on lower-spec devices. 

#### Organizing chats & content
- **Spaces** - group chats around a project, with shared instructions, reference files and memory. 
- **Chat folders** - drag one chat onto another in the sidebar to group them into a named folder.
- **Chat labels** - tag a chat with a colour that shows as a dot in the sidebar, Space view and chat menus.
- **Snippets** - save reusable prompts with an optional pinned model and click `Run` to start a fresh chat pre-filled and ready to send.
- **Custom snippet variables** - parameterize snippets with static globals and prompt-on-use placeholders that fill in when you run them.
- **Fork chats** - branch any conversation into a new copy that links back to its source.
- **Pinned responses** - pin any reply and jump straight back to it from a bar under the chat header.
- **Private chats** - an ephemeral chat that writes nothing to disk and wipes its transcript the moment you close it; open it from the ghost icon in the title bar.
- **Chat archive** - move chats out of the sidebar without deleting them, with an inline Undo if you mis-clicked; restore or delete them from dedicated archive view.
- **Search** - search across chats, message content, spaces and snippets, narrowed with a scope picker or an `in:` filter, plus a browser-style in-chat finder with phrase highlighting.

#### Composing & steering a chat
- **Slash commands** - type `/` in the composer for a command palette: `/fork`, `/regenerate`, `/compact`, `/private`, `/model`, `/persona`, `/snippet`, `/remember` and more.
- **Personas and Tones** - pick a role (Code Reviewer, Translator, ELI5...) and delivery style (Formal, Casual, Direct, Detailed...).
- **Context management** - a live bar under the composer shows how full the context window is, with one-click compaction that summarizes older turns to free space.
- **Import / export context** - export chat context to JSON or Markdown, optionally summarized to compact it, and paste exported data - or any text - back to any chat's context.
- **LaTeX math** - replies typeset with KaTeX: `$$…$$`, `$…$`, `\(…\)`, `\[…\]` and ` ```math ` fences render out of the box. `$` doubles as a currency sign, so `$…$` only typesets when the span actually reads as math - "it costs $5 and $10" stays prose. KaTeX ships inside the app (no network access) and is only read from disk the first time a reply contains math.

#### Model tools & capabilities
- **Tools** - let models call local tools including calculate, date/time, count, hash, UUID, base64, JSON, unit convert, text diff, sort, IP math and PDF generation. 
- **PDF generation** - the built-in pdf tool turns a model's structured spec (headings, lists, tables, page breaks) into a real PDF attached to the reply.
- **MCP support** - register Model Context Protocol servers (Streamable HTTP), test the handshake and inspect the tools they provide. 
- **Web fetch** - add URLs to messages and they will be fetched, sanitized and inlined to context. 
- **Temporal awareness** - inject current date, time, weekday and timezone into the system prompt so models can answer to "what day is it today?".

#### Viewing content
- **Code canvas** - open any code block in a wider view that's resizable and updates live as the model streams, with copy, export and Open in VS Code actions.
- **Attachment previews** - click an attachment to open the right viewer: image lightbox, multi-page PDF preview, code canvas, or a file-info card with Save.
- **Share a message** - copy any message as text or as a rendered chat-bubble image, save the image as a PNG, or open a pre-filled post on Facebook, X, Reddit or LinkedIn.

#### App, data & updates 
- **Data management** - make backups of your content to JSON file, restore data or permanently delete it with a few clicks, with a storage breakdown showing what your chats, attachments and Spaces actually weigh on disk. 
- **App lock** - optional PIN, password or PIN + password gate at launch, with opt-in auto-lock after inactivity or on minimize and a lock-now shortcut; credentials are hashed and stored in OS credential manager.
- **Themes** - glassy, gradient Aurora or flat Solid, both available in Dark and Light variants.
- **OTA updates** - get new features, bug fixes, performance improvements and security patches directly from the app, with an opt-in check at launch that tells you when a new version is out.

...and more! 

We are working on extending the list above, including new RAG and agentic features. 

---

## 💾 Install Loach

![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)

Loach can be installed from a pre-built package (Windows, Linux, macOS) or built from source.

### Install from a pre-built package

With each stable release we publish pre-built `.exe`, `.deb`, `.rpm`, `.AppImage` or `.dmg` packages ready to be downloaded and installed according to your operating system.

[![Latest release](https://img.shields.io/github/v/release/ztcs-software/loach?include_prereleases&label=release)](https://github.com/ztcs-software/loach/releases)

**👉 Download a pre-built package from the [latest stable release](https://github.com/ztcs-software/loach/releases/latest)**

> [!NOTE]
>For local models make sure [Ollama](https://ollama.com) is up and running (`ollama serve`). If you don't have any models pulled yet, Loach will offer to install one during onboarding, sized against your GPU's VRAM (or system RAM when there's no discrete GPU) so the suggestion actually runs well on your machine. 

### Install on Linux

All three Linux packages — `.AppImage`, `.deb` and `.rpm` — support in-app updates. Deb and rpm installs download the signed package and elevate through `pkexec` so the package database stays consistent; there's no apt/yum repository, so `apt upgrade` won't see new versions.

Builds target **glibc 2.35**, which makes **Ubuntu 22.04** and **Debian 12** the oldest supported distributions.

> [!NOTE]
>If you installed **v1.2.3 or earlier** from a `.deb` or `.rpm`, that build hides the Updates panel. Download a newer package once from the releases page and in-app updates take over from there.

### Install on macOS

The macOS build is **Apple Silicon (M-series CPUs) only** and is currently not notarized in the Apple Developer Program. On first launch macOS will block the app with a *"Loach is damaged and can't be opened"* or *"Apple cannot verify..."* warning. Bypass it once and the app runs normally:

- **Right-click** `Loach.app` in **Applications** → **Open** → click **Open** in the prompt, or
- Open **Terminal** and run:
  ```bash
  xattr -cr /Applications/Loach.app
  ```
  then launch the app normally.

Auto-updates are delivered through Loach's own signed updater (independent of Apple), so you only need to do this once on install. If a future update is blocked the same way, the same workaround applies.

### Build from source

#### Prerequisites

- **Node.js 20.19+** (or 22.12+) and **npm** — Vite 8 won't run on older 20.x point releases.
- **Rust 1.88+** via [`rustup`](https://rustup.rs) — the dependency tree's minimum; CI builds on 1.88.0
- Platform build tooling — install once via the official Tauri prerequisites guide: <https://tauri.app/start/prerequisites/>
  - **Windows**: Microsoft Visual Studio Build Tools, WebView2 runtime (preinstalled on Windows 11)
  - **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `libssl-dev`, `pkg-config`, `libsecret-1-dev`
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)

#### Clone and install

```bash
git clone https://github.com/ztcs-software/loach.git
cd loach
npm install
```

#### Run in development

```bash
npm run tauri dev
```

The Vite dev server runs on `http://localhost:1420` and the Tauri shell embeds it. 

#### Build production installers

```bash
npm run tauri build
```

Outputs land in `src-tauri/target/release/bundle/`:

- **Windows**: `.exe` (NSIS)
- **Linux**: `.deb`, `.rpm` and `.AppImage`
- **macOS**: `.dmg` and `.app` (Apple Silicon)

---

## 🚀 Getting started

Loach doesn't provide built-in models, therefore it requires a provider choice - Ollama or OpenAI-compatible endpoint (OpenAI API, llama.cpp, LM Studio etc.)

### Using with Ollama

```bash
ollama serve
ollama pull gemma4:e4b      # or any other tag
```

Loach probes `http://localhost:11434` on launch. Pulled models appear in the chat header dropdown automatically; the **Models** library tab also lets you pull new tags and customise existing ones from inside the app.

You don't have to run `ollama serve` yourself either - when nothing is answering, the model picker offers a **Start Ollama** button, and **Settings → Providers** can start it automatically every time Loach opens.

### Using with OpenAI-compatible endpoints

Open **Settings → Providers**, paste your API key (stored safely in your OS credential manager), and point the base URL to any compatible endpoint:

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` *(default)* |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| LiteLLM | `http://localhost:4000` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| Groq, OpenRouter, Together, Fireworks, Mistral | per their docs |

Only one OpenAI-compatible endpoint is active at a time — switch the base URL in Settings whenever you want to point to a different provider.

---

## 🛠️ Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri 2.x (Rust) |
| Frontend | React 19 + Vite 8 + TypeScript |
| Styling | Tailwind CSS + shadcn/ui (Radix primitives) + `tailwindcss-animate` + `@tailwindcss/typography` |
| Icons | `lucide-react` |
| State | Zustand (in-memory; backed by SQLite for persistence where appropriate) |
| Storage | SQLite via `rusqlite` (bundled feature — no system dependency) |
| Secrets | `keyring` crate → Windows Credential Manager / Linux Secret Service / macOS Keychain |
| Argon2id | `argon2` + `rand_core` (for app-lock hashing) |
| HTTP | `reqwest` with streaming + `rustls-tls` |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` (highlight.js) |
| Math | `remark-math` + `rehype-katex` + KaTeX, lazy-loaded from the bundle on first use |
| Document parsing | `pdfjs-dist` (PDF) + `mammoth` (DOCX) |
| PDF generation | `printpdf` 0.12 with a bundled Liberation Sans subset (Unicode-capable output) |
| System tray | Tauri 2 built-in (`tray-icon` feature) |
| Bundle targets | `.exe` (NSIS) on Windows; `.deb` / `.rpm` / `.AppImage` on Linux; `.dmg` on macOS (Apple Silicon) |

---

## 🔒 Storage and privacy

| What | Where |
|---|---|
| Chats, messages, folders, spaces, snippets, snippet variables, MCP servers, app settings | SQLite at `<app-data-dir>/loach.db` |
| OpenAI API key | OS credential manager (Windows Credential Manager / Linux Secret Service / macOS Keychain) |
| App-lock hash + hint | OS credential manager — same store, separate entry |
| Attached files (images, text) | Inlined into the message at send time; no separate file store |
| App data dir on Windows | `%APPDATA%\dev.loach.app\` |
| App data dir on Linux | `~/.local/share/dev.loach.app/` |
| App data dir on macOS | `~/Library/Application Support/dev.loach.app/` |

Loach launches and works completely offline as long as you stick to local providers. The **Models** library, **Spaces**, **Snippets**, search, parameter sidebar, app lock, and chat history are all available without network access. Only chat generations against remote endpoints (OpenAI, Groq, OpenRouter, …) require internet connection.

---

## 📜 License

[MIT](LICENSE) © ZTCS
