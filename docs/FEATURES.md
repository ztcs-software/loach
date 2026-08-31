# Loach — Feature Documentation

A native desktop chat client for local and OpenAI-compatible language models.
Loach runs as a Tauri 2 app on Windows, Linux and macOS, stores everything
locally in SQLite, and treats the OS credential store as the only place
secrets ever land.

This document is the source of truth for the public documentation website. Each
section describes a user-visible feature, what problem it solves, and the
options that surround it. Internal implementation notes are kept out unless
they leak through the UX.

---

## 1. Providers

Loach is a chat client, not a model. To start, you need at least one of the two
supported provider backends.

### 1.1 Ollama (local)

The default backend. Loach talks to a local `ollama serve` process over HTTP.

- **Base URL** — defaults to `http://localhost:11434`. Override in
  **Settings → Providers** if you run Ollama on another machine or port.
- **Auto-detected on launch** — the model list refreshes as soon as the app
  reaches the providers panel; if Ollama isn't running, the panel surfaces a
  soft "start ollama serve" hint instead of erroring.
- **Test connection** — the Providers panel exposes a one-click probe that
  pings `/api/tags` and reports the daemon version and visible model count,
  so the user can confirm a custom base URL works without leaving Settings.
- **Start Ollama** — when the daemon isn't answering, the model picker
  shows a **Start Ollama** button that launches it on demand and swaps in
  the model list once it responds. Errors surface in the menu itself.
- **Auto-launch Ollama** — an opt-in switch in **Settings → Providers**
  does the same thing at startup, if nothing is already running. Off by
  default (starting a background service is the user's call) and limited
  to a base URL that points at this computer — a remote Ollama isn't
  Loach's to start. The button above works either way.
- **Streaming**, **multimodal images**, and **thinking-mode reasoning** are
  passed through to the daemon when the chosen model supports them.

### 1.2 OpenAI-compatible (cloud or self-hosted)

Any endpoint that implements `/v1/chat/completions` works: the real OpenAI API,
plus vLLM, LM Studio, LiteLLM, OpenRouter, Groq, and other proxies.

- **Base URL** — defaults to `https://api.openai.com/v1`. Override per
  endpoint. A **presets dropdown** next to the field one-clicks the URL to
  the documented endpoint for OpenAI, llama.cpp (`llama-server`), LM Studio,
  vLLM, or LiteLLM.
- **API key** — saved into the OS credential manager (Windows Credential
  Manager, Linux Secret Service, macOS Keychain). Never written to disk in
  plain text, never shipped to the renderer.
- **Catalog listing** — fetched on demand; the panel hides itself if no key
  is configured rather than spamming 401s.
- **Test connection** — calls the endpoint's `/models` listing with the
  stored key and reports the model count (or a readable error) so the user
  can verify a base URL + key pair before opening a chat. Disabled while
  there's an unsaved key in the input.

### 1.3 Model picker

Every chat shows a model dropdown in its header that lists both providers'
catalogs grouped by name. Switching a chat's model:

- Persists onto the session row so reloads remember it.
- Updates the global "most recent (provider, model)" pair used by **Default
  model → Use most recent** for new chats.
- Triggers Ollama to unload the previous model from VRAM and warms the new
  model's parameter cache for the parameters sidebar.

---

## 2. Chats

The primary surface. A "chat" is a session, a model selection, and a
transcript of messages.

### 2.1 The transcript

- **Streaming tokens** — assistant replies render token-by-token, batched on
  `requestAnimationFrame` so the UI stays smooth even on fast local models.
- **Thinking traces** — for reasoning-capable models the chain-of-thought
  stream is rendered into a separate collapsible block above the answer.
- **Tool-call blocks** — when the model calls a tool (a built-in utility
  or an MCP tool), the calls collapse into a single **"Called N tools"**
  header above the answer, styled like the Thinking block. Expand it to
  see each call's name, arguments, and result (or error).
- **Metrics chip** — every assistant turn shows the prompt+completion token
  count, wall-clock time, and tokens/sec when the provider reports them.
- **Markdown + code highlighting** — `react-markdown` + `rehype-highlight`
  with GitHub-flavored markdown extensions. Tables, lists, footnotes, and
  language-aware syntax highlighting work out of the box.
- **LaTeX math** — formulas typeset with KaTeX, no opt-in required.
  `$$…$$`, `$…$`, `\(…\)`, `\[…\]` and ``` ```math ``` fences all render,
  and a `$$…$$` written on a single line is promoted to a centred display
  block. TeX that doesn't parse degrades to showing its own source (parse
  error on hover) rather than flashing an error, which keeps half-typed
  formulas quiet mid-stream. Applies to assistant replies in the transcript
  and Private Chat; app-authored markdown like release notes opts out
  explicitly.
- **Currency-safe `$…$`** — `$` doubles as a currency sign, so a
  single-dollar span only typesets when it reads as math: the content must
  hug both delimiters, stay on one line, not follow a word character, and
  not be chased by a digit. "it costs $5 and $10", "between $5-$10" and
  "US$5" all stay prose, while `$x^2$` — the delimiter most models actually
  emit for inline math — renders with no settings hunt. `\$` always means a
  literal dollar sign.
- **Lazy engine** — KaTeX is a ~270 KB JS chunk plus a 29 KB stylesheet and
  59 font files, all bundled into the installer like the rest of `dist/`.
  **Nothing is fetched over the network** — the window CSP
  (`default-src 'self'`) would block it if anything tried. What's deferred is
  only *when it's read from disk and parsed*: a dynamic `import()` fires the
  first time a message in that session actually looks like it contains math,
  so a launch that never renders a formula never pays for one. It reloads on
  the next launch — the deferral is per session, not a one-time install step.
- **Unicode symbol fallback** — independent of the setting above and always
  on: loose single-token TeX in prose (`\rightarrow`, `\alpha`, `\sum`) is
  rewritten to the equivalent Unicode character. It runs over the parsed
  tree, so code blocks, inline code, and anything inside math delimiters are
  left byte-for-byte intact.
- **Long-prompt clamp** — user bubbles that paste in dozens of lines clamp
  to ten lines with a **Show more** toggle so the answer stays visible.
- **Right-click menu** — right-click any bubble for a contextual menu with
  **Copy** (the current selection inside that bubble, or the full message
  when nothing is selected) and **Select all** (highlights just the body
  text — metrics and toggles stay outside the selection).
- **Per-message action menu** — a `…` button below each bubble exposes the
  deliberate full-message actions: **Copy message** on every bubble,
  **Save as Snippet** on user prompts, and **Regenerate** on the *last*
  assistant message (drops the previous reply, re-sends the preceding user
  turn, and streams a fresh answer in place). **Share** (§2.12) is on every
  bubble; **Pin this response** (§2.11) on assistant replies.

### 2.2 Composer

The input box at the bottom of every chat.

- **Multiline input** with Enter to send and Shift+Enter for newline.
- **Slash commands** — type `/` at the start of the composer to open the
  command palette and run chat actions, switch model, fetch a URL, and
  more without leaving the keyboard (see §2.9).
- **File picker** (`+` icon) — opens the native file dialog directly. Drag
  and drop also works onto the composer or anywhere over the chat area.
- **Suggestion chips** — on the welcome hero screen of an empty chat,
  shortcuts seed the composer with starter prompts ("Explain a concept",
  "Write code", "Summarize a file", "Brainstorm").
- **Persona pill** — when a persona is active the composer shows a chip
  with the persona name above it. Click to swap.
- **Send / Stop morph** — while a reply is streaming for the active chat,
  the send button becomes a stop button. Cancelling persists whatever has
  been streamed so far.

### 2.3 Attachments

Drop any file up to **20 MB** into the composer. Loach handles three flavours:

- **Images** (PNG, JPEG, WEBP, GIF) — sent as base64 to vision-capable
  models alongside the text turn.
- **Text and code** (one of ~50 recognised extensions, plus anything with a
  `text/*` MIME) — read verbatim and inlined into the prompt as a fenced
  code block.
- **Documents** — **PDF** (text-extracted via `pdfjs-dist`) and **DOCX**
  (extracted via `mammoth`). Page count and a per-attachment **200,000-char**
  cap. The file chip flags truncation; the model is also told inline.

Total inlined content per message is capped at **500,000 characters** across
attachments + URL fetches + the prompt itself. Anything that doesn't fit is
listed by name in a trailing footer so the model knows it exists.

Files Loach can't decode (legacy `.doc`, archives, binaries) are kept as
base64 in the transcript and announced to the model by name so it can ask
for a readable version.

Clicking an attachment chip opens a per-type preview without leaving the
chat:

- **Images** → lightbox with a **Save** button (clicking the dim backdrop
  closes it, matching standard lightbox behaviour).
- **PDFs** with original bytes retained → multi-page rendered preview
  (lazy per-page rasterisation via `pdfjs-dist`) with **Save**.
- **Text and code** → opens in the **Code canvas** (§10) with language
  highlighting and export.
- **DOCX, binaries, and older PDFs without raw bytes** → a file-info card
  with **Save**, so the user can still pull the attachment back out even
  when Loach can't render it inline.

### 2.4 Concurrency model

Loach runs **exactly one generation at a time across all chats** with a global
FIFO queue:

- Sending in a busy chat refuses the second submit (one in-flight per chat).
- Sending in another chat while one is running parks the request; the
  sidebar row shows a spinner while it waits.
- The chat header offers **"Respond now"** for any waiting chat to jump
  the queue and cancel the current runner.
- A cancelled or errored stream persists the partial output and a visible
  error tail so the bubble is never silently empty.

### 2.5 Chat list (sidebar)

- **Grouped by recency** — Pinned, Today, Yesterday, This week, Older.
- **Per-row indicator** — spinner while generating, accent dot for unread
  replies that finished while you were in another chat.
- **Per-row menu** — Pin / Unpin, Label, Rename, Move to Archive, Delete.
- **Right-click** anywhere on the row opens the same menu.
- **Spaces icon** marks chats that belong to a Space.
- **Colour labels** — tag a chat Red, Amber, Green, Blue, Purple or Pink
  from the **Label** submenu of any chat menu (sidebar row, chat header,
  or Space view). The colour renders as a dot at the start of the row and
  follows the chat everywhere it's listed. **No label** clears it.
- **Folders** — drag one chat row onto another to group them. Loach asks
  for a folder name and files both chats into a **Folders** section that
  sits between Pinned and the date groups. Folders are flat — they never
  nest — start collapsed, and remember which ones you left open between
  launches.
  - Drop a chat on a folder to file it; drop it on a date caption (Today,
    Yesterday, …) to take it back out, or use **Remove from folder** in
    the row menu.
  - A filed chat leaves the date groups, but a pinned one still appears
    under Pinned as well.
  - The folder's own menu offers **Rename** and **Delete folder**.
    Deleting never deletes chats — they move back to the main list.

### 2.6 Header actions (per chat)

- **Rename**, **Pin/Unpin**, **Label**, **Move to Archive**, **Delete**.
- **Fork this chat** — clone the conversation into a new chat (same model
  and Space) so you can branch a tangent without disturbing the original.
  The fork carries a **"Forked from …"** badge in its header that jumps
  back to the source; the badge disappears if the source is deleted. Also
  available from a message's `…` menu (forks up to that point) and via the
  `/fork` command.
- **Copy as Markdown** — copies the full transcript to the clipboard.
- **Export** to JSON or Markdown via the native save dialog. A **Compact
  context** toggle in the dialog exports a summarised version instead of
  the verbatim transcript (your chat isn't changed). The dialog and file
  write both happen in Rust; the renderer never sees the path.
- **Import context** — paste exported JSON/Markdown or any plain text;
  it's parsed into messages and appended to the current chat. A **Hide
  from transcript** toggle folds the imported messages into a single
  collapsed card instead of showing them inline — either way they're
  still sent to the model.
- **Search transcript** — Cmd/Ctrl+F-style find within the chat.

### 2.7 Archive

Chats can be archived (kept around but out of the main list). The Archive
lives in **Settings → Archive** and lets you:

- Open an archived chat read-only.
- Unarchive to bring it back into the main list.
- Permanently delete from the archive.
- "Archive all" to mass-park your current chats before starting fresh.
- "Remove all" to permanently delete every archived chat in one step
  (guarded by a typed-confirm dialog because it's irreversible).

### 2.8 Private Chat

A **dark-only, ephemeral chat surface** for conversations that should leave
no trace. Open it from the ghost icon in the title bar.

- **Nothing is persisted.** No session row, no message row, no metrics, no
  attachment store. The transcript lives entirely in memory and is wiped
  the moment the overlay closes (along with the picked model, persona,
  tone, per-chat instructions, and parameters panel state).
- **Ollama-only.** OpenAI-compatible providers aren't shown in the model
  picker — the data path for the cloud providers crosses too many
  intermediaries to honour the "leaves no trace" promise.
- **MCP tools are blocked.** Servers configured in **Settings → MCP** are
  not exposed to the model inside Private Chat, so a tool call can't
  side-channel the conversation out to a third party. Built-in tools
  (§8.3) still work — they run entirely on your machine, so they can't
  leak the conversation.
- **No backdrop / Esc close.** The overlay can only be dismissed by the
  explicit `X` in its header. The wipe is destructive; we don't want a
  stray click to throw away the conversation.
- **Regular chat is paused.** Opening Private Chat cancels any in-flight
  regular generation; the regular chat surface is non-interactive
  underneath until the overlay closes.
- **Same shaping layers as regular chats** — persona, tone (falling back to
  the default tone from **Settings → General** when not overridden), and a
  free-form per-chat instructions textarea, layered persona → instructions
  → tone. No Space context, no `{{USER_NAME}}` substitution, no temporal
  preamble — those layers belong to persistent chats.
- **Same parameters panel** — Simple / Advanced toggle, model defaults,
  Thinking and Low VRAM toggles. Closes and wipes along with the rest of
  the overlay.

### 2.9 Slash commands

Type `/` as the first character in the composer to open the **command
palette** — a floating list that filters as you type. Arrow keys move the
selection, **Tab** completes the highlighted command, and **Enter** runs a
fully-typed command (or completes a partial one). **Esc** dismisses the
palette. Anything that isn't a recognised command is sent as an ordinary
message, so a prompt that happens to start with `/` is never swallowed.

Commands are grouped the way `/help` lists them:

- **Chat** — `/new`, `/clear`, `/rename <title>`, `/pin`, `/archive`,
  `/delete`, `/fork`, `/regenerate`, `/copy [N]` (copy the last or
  Nth-latest assistant reply), `/export`, `/stats`, `/compact`,
  `/private`.
- **Model & persona** — `/model <name>`, `/persona <name>` (both
  fuzzy-matched against the catalog).
- **Listings** — `/list models | personas | spaces | snippets | mcp |
  providers | memories`.
- **Prompts** — `/instructions <text|clear>` (set or clear the per-chat
  system prompt), `/snippet <name>` (expand a saved snippet into the
  composer).
- **Memory & spaces** — `/remember <fact>`, `/forget <id|query>`,
  `/space <name>`.
- **Tools & web** — `/tools` (list tools from enabled MCP servers),
  `/web-fetch on|off`, `/fetch <url>`, `/thinking on|off`.
- **App** — `/settings [tab]`, `/help`.

`/clear` and `/delete` are destructive and route through a confirmation
dialog before they run.

### 2.10 Context usage and compaction

A slim **context usage bar** sits just above the composer. It shows how
much of the model's context window the chat is using — `used / total`
tokens and a percentage — with a popover that breaks the estimate down
into the system prompt, message history, and attachments.

When a chat grows long, **Compact context** (the button on the bar, or
the `/compact` command) summarises the older turns with the chat's own
model and tucks the summary into the system prompt. The original messages
aren't deleted — they stay in the transcript for scrollback, marked with a
compaction divider, but are dropped from what the model sees on the next
turn so the freed context goes to new conversation. Compaction is only
offered once a chat is large enough to benefit (a handful of messages and
at least a quarter of the window in use).

### 2.11 Pinned responses

Any assistant reply can be pinned from its `…` menu (**Pin this response**).
A pin is a bookmark, not an edit — the message still reaches the model
exactly like every other turn.

- A **Pinned** bar appears under the chat header listing each pin as a
  one-line chip. Clicking a chip scrolls that response back into view and
  flashes it.
- Chip text is the response with its markdown stripped, so a code-only
  answer previews as its first line of code. Hovering shows more of it,
  which is usually enough to tell two similar pins apart.
- The pinned reply carries a small **Pinned** badge under its bubble.
- **Unpin this response** lives in the same `…` menu; the bar disappears
  with the last pin.
- Pins are stored with the chat, so they survive restarts and travel in
  exports.

### 2.12 Sharing a message

**Share** in any message's `…` menu opens a dialog with two modes.

- **As text** — the message as written. **Copy** puts it on the clipboard,
  or hand it to **Facebook**, **X**, **Reddit** or **LinkedIn**: Loach
  opens that network's composer in your browser with the text pre-filled,
  trimmed to the length each one accepts. The clipboard always gets the
  full text.
- **As image** — the same message drawn as a chat-bubble PNG that follows
  your current light/dark theme, captioned **Prompt** or **AI Response**
  and footed with "Shared from Loach". **Copy** puts the image on the
  clipboard; **Save** writes the PNG through the native save dialog. The
  networks' share links carry text only, so image mode swaps them for
  Save.

Loach uploads nothing itself — sharing either hands text to your browser
or leaves an image on your clipboard.

---

## 3. Spaces

A **Space** is a long-lived workspace that bundles instructions, reference
files, and a memory store. Every chat created inside a Space inherits that
context.

### 3.1 What a Space holds

- **Instructions** — a system prompt that *overrides* any global or per-chat
  prompt when set (the Space is the user explicitly opting into space-level
  guidance).
- **Reference files** — text files and PDFs are inlined into the system
  prompt of every chat in this Space; images ride along with the user
  turn. Total per-Space cap: **200 MB**.
- **Memory** — auto-extracted one-line facts about the user (see §3.3).
- **Default provider and model** — pinned per-Space so a "code review"
  Space can always start in a different model than a "writing" Space.
- **Default generation parameters** — temperature/top-p/etc., layered
  between model defaults and per-chat overrides.

### 3.2 Lifecycle

- Create from the **Spaces** sidebar tab or the in-app library tile.
- Edit name, description, instructions, default model, and defaults.
- Open a Space to see its detail view — chats inside it, instructions,
  files, memory, and model defaults — each on its own tab. Each chat row
  in the Chats tab exposes the same `…` action menu as the main sidebar
  (Pin / Unpin, Rename, Move to archive, Delete).
- Delete a Space and all its associated files / memories cascade out of
  the DB.

### 3.3 Space Memory

Optional per-Space auto-memory. After every assistant reply in a Space, Loach
fires a one-shot LLM call (against the same provider/model the user is
chatting with) and asks it to extract durable, single-sentence facts about
the user. Survivors are deduped (model dedupe + local Jaccard string
similarity) and persisted.

- **Toast for every save** — "Saved to memory" pill with the new fact,
  so the user can see what landed in long-term context.
- **Memory tab** — review, edit, or delete any auto-saved row, and add
  facts manually.
- **Per-Space toggle** — turn extraction off without wiping existing rows.
  Existing memories continue to ride along in every chat; only new writes
  stop.
- **Caps** — at most 60 memories sent into the extractor prompt to keep
  context small. Each fact is rejected if longer than 280 chars.

Memories are silently injected into the system prompt of every chat inside
the Space as a `--- Space memory ---` bulleted list. Cancel / error turns
never trigger extraction, since the assistant text is incomplete.

---

## 4. Snippets

A **Snippet** is a saved prompt with an optional pinned provider/model. Live
in the **Snippets** sidebar tab.

- **Create** with title + prompt body. Optionally pin to a specific provider
  and model so "Run" always starts a chat there.
- **Run** — opens a fresh chat (with the pinned model if set) and primes the
  composer with the snippet's prompt. The user can edit before sending.
- **Bookmark from an assistant reply** — the right-click menu on any
  assistant message offers "Save as snippet", which prefills the editor with
  that text.
- **Library view** — tile grid sorted by recency, search field at the top.
- **Edit / Delete** behind a per-tile `⋯` menu.

### 4.1 Snippet variables

Snippet bodies can contain `{{PLACEHOLDER}}` variables (uppercase names)
that get filled in when the snippet is expanded:

- **Static variables** — reusable key/value pairs defined once in the
  Snippets library (e.g. `{{TEAM_NAME}}` → "Engineering"). They're
  substituted automatically every time a snippet that references them is
  run. The built-in template variables (`{{USER_NAME}}`,
  `{{CURRENT_DATE}}`, …; see §15) are reserved and can't be redefined.
- **Prompt-on-use placeholders** — any `{{PLACEHOLDER}}` left unresolved
  after the static pass opens a small fill-in dialog when you run the
  snippet. Your answers are remembered per snippet for next time.

---

## 5. Models

The **Models** sidebar tab is a full management surface for the local Ollama
catalog plus a read-only listing of the OpenAI catalog.

### 5.1 List view

- Tiles for every installed model: family, parameter size, on-disk size,
  quantization, capabilities (thinking / tools / vision).
- **Pull a model** (`Pull` button) — opens an inline progress chip with
  the percentage and current digest. Can be cancelled.
- **Refresh** — re-queries `/api/tags` and the OpenAI listing.
- **Search** — substring match across model names.
- **Open** any Ollama model to edit it in the **Models editor**.

### 5.2 Models editor

For a single Ollama model, the editor lets you:

- **Inspect** the Modelfile, the system prompt, the chat template, parsed
  PARAMETER block, and the capabilities tags.
- **Edit** any of those fields in the form.
- **Save as…** writes a *new* derived model via `POST /api/create` —
  Loach never overwrites the base, so the FROM line always points at
  something you can revert to.
- **Copy model** — duplicate under a new tag without changes.
- **Delete model** — irreversible removal of the local copy.
- **Thinking preference** — per-model override for the Thinking toggle.
  Sits between the Modelfile default and per-chat overrides.
- **Open a fresh chat** pre-selected to this model.

### 5.3 Modelfile guardrails

The "Save as…" form refuses to compile a Modelfile that would inject
additional directives via a malicious base tag, system block, or template
block. The base tag is matched against a conservative `[A-Za-z0-9._/-]`
allowlist; SYSTEM and TEMPLATE bodies are rejected if they contain `"""`
(which the Ollama parser would treat as an early block-end).

---

## 6. Personas and tones

Two style layers that compose with the chat's system prompt at send time:

### 6.1 Personas (role)

Pick from a curated list of preset roles that pre-pend a system prompt:

- **None** — no persona, uses the user's instructions only.
- **Code Reviewer** — bug hunts, security checks, blunt PR feedback.
- **Writing Editor** — tighten prose without flattening voice.
- **Brainstorm Partner** — diverge first, converge later, pushes back.
- **Explain Like I'm 5** — plain language and concrete analogies.
- **Translator** — accurate translation that preserves tone and idiom.

Picked from the composer's `+` menu or the parameters sidebar. Per-chat.
Not persisted across launches by design; the seed prompt itself lives on
the session and survives a reload.

### 6.2 Tones (style)

Style modifier appended *after* the persona / instructions:

- **Default** — model's natural voice (no override).
- **Direct** — leads with the point; drops hedges and preamble. Replaces
  the old "Concise" tone.
- **Detailed** — thorough coverage with caveats and reasoning.
- **Casual** — plain English, conversational.
- **Formal** — business register.
- **Encouraging** — supportive framing for learners and first drafts.
- **Playful** — light wit and personality, humour in service of clarity.
- **Skeptical** — stress-tests claims, surfaces counterarguments and
  edge cases.
- **Socratic** — guides with questions instead of handing over answers
  (switches to direct answers when explicitly asked).

Set per chat from the parameters sidebar, or pick a default tone in
**Settings → General**. The General tab has an expandable
**"What each tone does"** drawer that shows the one-line summary for
every tone, so the default-tone picker doubles as a reference.

---

## 7. Generation parameters

Every chat has a slide-out **parameters panel** on the right. Two modes:

- **Simple** — max tokens, num_ctx, seed, Thinking toggle, Low VRAM
  toggle, per-chat system prompt textarea. The view stays terse on
  purpose so the common knobs are reachable without scrolling.
- **Advanced** — adds **temperature**, top_p, top_k, min_p,
  repeat_penalty, frequency and presence penalties, GPU layer count,
  and everything else the providers expose.

The same panel is reused by **Private Chat** (§2.8) with the same
Simple / Advanced split.

The parameter merge order, top to bottom (later layers win):

1. **App defaults** — universal fallback (temp 0.7, top_p 0.95, etc.).
2. **Model defaults** — parsed from the Ollama Modelfile's PARAMETER
   block; cached after the first chat with that model.
3. **Per-model preferences** — currently the Models-editor Thinking
   toggle.
4. **Space defaults** — when the chat belongs to a Space with its own
   pinned parameters.
5. **Per-session overrides** — what the sliders in this panel save.
6. **Global app overrides** — Settings → General Low-VRAM pin, which
   forces `low_vram: true` on every Ollama request.

A **Reset to defaults** button in the panel header clears the per-session
overrides and falls back to the merged defaults.

### 7.1 Thinking toggle

Only meaningful for Ollama models whose `capabilities` include `"thinking"`.
Sets the `think` parameter on `/api/chat`; ignored by OpenAI providers.
The default for new chats comes from **Settings → Features → Thinking**.

### 7.2 Low VRAM toggle

Ollama-only. Forces smaller batches and a leaner KV cache. The per-chat
toggle is overridden when **Settings → Features → Low VRAM mode** is on —
the panel shows the toggle pinned and disabled with a pointer back to the
setting.

---

## 8. Tools

Capabilities Loach offers to the models. Opt-in in **Settings → Tools**.

### 8.1 Web fetch

When a prompt contains an `http(s)://` URL, Loach downloads the page,
strips HTML to readable text, and appends it as a fenced block.

- **Off by default** — Loach is offline-first; opt in to make outbound
  HTTP calls.
- **Per-message cap of 5 URLs**, deduped.
- **30 s total timeout** per URL, **10 s connect timeout**.
- **5 MB body cap** and ~12,000 chars of extracted text per fetch.
- **SSRF guard** — only `http`/`https` schemes; the resolved IP must not
  land on loopback, RFC1918 private ranges, link-local, or any other
  special-use range. A hostname that DNS-resolves to a private address is
  rejected. Redirects are walked manually and re-screened per hop.
- **Failures are silent per-URL** — a dead link does not block the send;
  the failure is rendered as a short stub so the model knows we tried.
- **Shown on the reply** — the URLs Loach fetched for a turn appear as
  small chips on the assistant message.

### 8.2 MCP (Model Context Protocol)

Loach speaks the **Streamable-HTTP** MCP transport. Configure servers in
**Settings → MCP**.

For each server:

- **Name** — display label.
- **URL** — `https://…` endpoint.
- **Headers** — optional key/value map (typically `Authorization`).
- **Enabled toggle** — disable without deleting.
- **Test connection** — runs `initialize` + `tools/list` against the
  endpoint without persisting and reports the server name, protocol
  version, and tool list.

URLs are validated (the scheme must be `http`/`https`, and link-local
cloud-metadata addresses are refused; `localhost` and private LAN addresses
are allowed, since self-hosted MCP servers commonly live there). Headers go
through size and character checks, and per-request bodies are capped at 4 MiB
so a misconfigured endpoint can't OOM the app. Per-request timeout is 30 s.

### 8.3 Built-in tools

A set of small, local utilities the model can call mid-answer through the
same tool-call loop as MCP. Each has its own toggle in **Settings →
Tools** and all of them are **off by default** — turn on only what you
want a given model to reach for. They run entirely in Rust on your machine
(no network, no disk writes beyond a PDF you ask for), so they also work
inside Private Chat.

- **calculate** — evaluate arithmetic, trig, functions, and constants.
- **datetime** — parse, format, and do arithmetic on dates/times, with
  timezone conversion and business-day counting.
- **count** — count characters, bytes, words, lines, or substring hits.
- **hash** — SHA-224/256/384/512 over UTF-8, hex, or base64 input.
- **uuid** — generate v4 or v7 UUIDs (up to 100 per call).
- **base64** — encode/decode with the standard or URL-safe alphabet.
- **json** — validate, pretty-print, or pull values out by JSON Pointer.
- **unit_convert** — convert between units across nine categories (length,
  mass, volume, speed, time, area, energy, pressure, temperature).
- **diff_text** — unified diff between two strings, by line, word, or
  character.
- **sort** — sort lines (lexical, natural, or numeric; reverse / unique).
- **ip** — CIDR membership checks and subnet info.
- **pdf** — generate a downloadable PDF from a structured spec (headings,
  paragraphs, lists, tables, page breaks). The result lands in the chat as
  a previewable, savable attachment.

Calls render in the collapsible tool-call block described in §2.1.

---

## 9. Search palette

Press **Cmd/Ctrl+K** (or click the title-bar search pill) to open a global
command palette:

- Cross-searches **chats**, **spaces**, and **snippets**.
- Empty query shows recent suggestions across all three.
- Arrow keys to move, Enter to commit, Esc to dismiss (or to clear a
  non-empty query first).
- Picking a chat opens it. Picking a Space opens its detail view. Picking
  a Snippet starts a fresh chat with the snippet's prompt primed.

The palette is suppressed while onboarding or the lock screen owns the
window.

---

## 10. Code canvas

Inline code blocks in assistant messages get an **"Open in canvas"** button.
Clicking opens a right-side panel:

- Title bar with the inferred language and the snippet title.
- **Copy** to clipboard.
- **Export** — opens the native save dialog with a sensible default
  filename (extension picked from the language: `snippet.ts`, `snippet.py`,
  `Dockerfile`, etc.).
- **Open in VS Code** — writes the snippet to a temp file and opens it in
  VS Code via the `code` CLI. If `code` isn't on your PATH, the button
  surfaces a short hint on how to add it rather than failing silently.
- Read-only body with line numbers and syntax highlighting via
  `highlight.js`. Highlighting is language-aware; unknown languages fall
  back to auto-detect.
- **Live updates** — when opened on a reply that's still streaming, the
  canvas keeps mirroring the latest code block as more tokens arrive.
- **Resizable** — drag the left edge to set the panel width; the choice
  is remembered.

The canvas and the parameters sidebar share the right slot — the canvas
wins when both would be open.

---

## 11. Appearance

In **Settings → Appearance**:

- **Theme** — *Solid* (calm flat background, azure accent) or *Aurora*
  (animated glass-mesh gradient, warm orange accent).
- **Color mode** — Light, System, Dark.
- **Font size** — Small, Normal, Large. Applied as a CSS scale to both
  rem-based and pixel-based text sizes.

Background style and color mode update instantly. The title bar shows the
window controls (minimise / maximise / close) inline since the window is
borderless on both platforms.

---

## 12. App lock (Security)

Optional credential gate that runs before any chat data hydrates. Configure
in **Settings → Security**.

- **PIN** (4, 6, or 8 digits), **Password**, or **both**.
- **Optional hint** stored alongside (plaintext — the user has to be able
  to read it after a failed unlock).
- **Argon2id** hashing in Rust; the lock blob lives in the OS credential
  store (Windows Credential Manager / Linux Secret Service / macOS
  Keychain), never on disk in plaintext, never in SQLite.

### 12.1 Lock screen

Fills the window until the user authenticates. PIN field first when both
are required (fastest to type on a numeric pad). Wrong attempts clear the
PIN field (the password field is kept so the user can fix a typo).

### 12.2 Rate limiting

After 5 consecutive failed unlocks the unlock command is refused for an
escalating window (30 s, 60 s, 2 min, … capped at 2 h). Counter resets on
a successful unlock and on app restart.

### 12.3 Re-authentication for destructive actions

Changing or removing the lock and the destructive Data commands (import,
wipe, factory reset) require the user's *current* credentials even though
the app is unlocked, so a compromised renderer cannot silently disable the
gate or trigger a wipe.

---

## 13. Data management

**Settings → Data** is where backups, restores, and cleanups live.

- **Export everything** — produces a single JSON blob with every chat,
  message, folder, Space, file, memory, snippet, MCP server, and setting.
  Native save dialog through a Rust-owned write so the renderer never
  sees the chosen path.
- **Import** — open a previously exported JSON. Reports per-table row
  counts in a toast on success. Requires current app-lock credentials
  when a lock is configured.
- **Wipe user data** — drops chats, Spaces, snippets, MCP servers, and
  memories, but keeps app settings and the stored OpenAI key. Gated on
  the app-lock credentials.
- **Factory reset** — wipe user data + clear all settings + remove the
  OpenAI key from the credential store. Re-fires onboarding on next
  launch. Irreversible.

---

## 14. Onboarding

A six-step wizard runs on first launch (and after a factory reset). Each
step writes its choice straight into settings, so dismissing partway through
still leaves the app in a consistent state.

1. **Welcome** — intro card, plus *Restore from backup* for users arriving
   from another install.
2. **Provider** — pick Ollama or add an OpenAI key. This is the only
   required step; the X / Esc on it routes through a confirm dialog. It sits
   second so a model download has the rest of the wizard to make progress.
3. **Features** — defaults for Temporal awareness, Thinking, and Low VRAM
   (recommends ON / ON / OFF). Committed on Skip as well as Continue.
4. **Tools** — Web fetch and the twelve in-process utility tools, all off to
   start. Unlike Features, this screen writes **only** what the user
   actually toggles, so skipping past can't opt them into networking or
   inflate the tool catalogue sent to the model. MCP is described here but
   configured in Settings.
5. **Prompt** — the global *Custom instructions* textarea.
6. **Final** — closes the wizard, lands the user in a fresh chat with the
   model dropdown auto-opened so they can pick a model immediately.

The wizard does not ask for a display name. `{{USER_NAME}}` still resolves
from Settings → General; it just isn't collected up front, because the value
only pays off for users who go on to write it into a custom instruction.

### 14.1 Choosing a model

When Ollama is running but has no models, the step reads the host's capacity
(`system_info`) and leads with a single recommendation — the largest catalog
entry that still runs comfortably — instead of asking a newcomer to pick blind
from a dozen tags.

**It sizes against VRAM, not RAM, whenever a discrete GPU is present.** That is
the number which decides whether a model is usable: Ollama loads what fits into
VRAM and runs the remaining layers on the CPU, so an 18 GB model behind an 8 GB
card technically "fits in RAM" and still generates at a crawl. Sizing on RAM
alone both over-recommended on big-RAM/small-GPU machines and under-recommended
on small-RAM/big-GPU ones. Detection lives in `src-tauri/src/gpu.rs`:

- **Windows** — DXGI `DedicatedVideoMemory`, vendor-neutral across NVIDIA / AMD
  / Intel, no external tooling.
- **Linux** — `nvidia-smi`, else the amdgpu sysfs node. Intel Arc is not
  covered and falls back to RAM.
- **macOS** — deliberately none. Apple Silicon is unified memory, so system RAM
  already *is* the GPU budget and a separate figure would double-count it.

Adapters under 1 GB of dedicated memory are ignored as integrated graphics,
which carve out system RAM and are already covered by the RAM path. Every probe
is best-effort: anything unreadable falls back to RAM, which stays correct for
CPU-only and integrated setups.

Each variant carries a fit badge from the pure helpers in
`src/lib/modelChoice.ts`: **Best fit**, **Tight** (fits the budget, no
headroom), **Partly on CPU** (exceeds VRAM but fits RAM — it runs, just slowly),
**Needs ~N GB** (exceeds both), or **Not enough disk**, which also disables its
Pull button. The card names the constraint it used — "Based on 8 GB VRAM ·
NVIDIA GeForce RTX 4060" rather than a RAM figure — since telling a GPU owner
about their RAM describes the wrong bottleneck. Outside the Tauri shell
`system_info` returns null and the catalog renders unadorned.

Neither provider path pins a default model silently any more. Ollama shows a
picker of the models it found; the OpenAI path ranks the endpoint's catalog
so a chat model leads (`/v1/models` order routinely puts an embedding or
audio model first) and shows the pick in the same picker.

### 14.2 Downloads that outlive the wizard

Pulls started here keep running while the user finishes setup, so the
download is surfaced the whole way:

- A progress strip pinned to the bottom of every remaining wizard step.
- The final screen swaps "You're all set" for "Setup complete / still
  downloading" rather than claiming readiness it doesn't have.
- `ModelDownloadBanner` above the composer in the chat itself.
- `sendUserMessage` refuses a send against a still-downloading model with
  "<tag> is still downloading (43%)". Without it Ollama returns 404 for the
  missing tag, which `providerErrors` renders as "endpoint or model not
  found. Check the model name and URL" — a wrong and unactionable first
  impression.

### 14.3 When Ollama isn't reachable

The step offers **Start Ollama** (the same `ollama_start` command the chat
header uses) before suggesting a download, since "installed but not running"
and "not installed" look identical from a failed probe — the error from a
failed start is what tells them apart. It also re-probes every 3 s in the
background, so a user who leaves to install Ollama returns to a green panel
instead of a stale warning they have to know to dismiss.

---

## 15. Custom instructions and template variables

The **Custom instructions** textarea in **Settings → General** is applied
as the system prompt of every new chat (Spaces and per-chat overrides win
when set). Supported template variables — usable anywhere a prompt is
authored (custom instructions, Space instructions, snippets, per-chat):

- `{{USER_NAME}}` — the name from **Settings → General**.
- `{{CURRENT_DATE}}` — `YYYY-MM-DD`.
- `{{CURRENT_TIME}}` — `HH:MM` (24-hour, local).
- `{{CURRENT_WEEKDAY}}` — `Monday`, `Tuesday`, …
- `{{CURRENT_DATETIME}}` — `YYYY-MM-DD HH:MM`.
- `{{CURRENT_TIMEZONE}}` — IANA zone (e.g. `Europe/Warsaw`) with a UTC
  offset fallback for very old WebViews.

### 15.1 Temporal awareness

When **Settings → Features → Temporal awareness** is on, Loach prepends a
short "Current date / time / timezone" preamble to every system prompt if
the prompt doesn't already use a `{{CURRENT_*}}` placeholder. Authors who
need the values inline drop the placeholders in directly; everyone else
gets the auto preamble. The Features tab also includes an expandable
**"Template variables"** cheat sheet listing every placeholder with an
example value.

---

## 16. Default model preferences

**Settings → General → Default model** controls which model new chats land
in. Three modes:

- **Use most recent** (default) — pick up wherever you left off.
- **Pin to provider** — most-recent model for Ollama or OpenAI
  specifically.
- **Pin to a specific model** — always start in this exact model.

**Default model preload** (off by default, Ollama-only): on app launch
Loach sends an empty chat to the resolved default model so it loads into
VRAM ahead of your first real prompt. Pins VRAM even if you open Loach
just to read old chats, so the toggle is opt-in.

---

## 17. Updates

In-app updater for the Tauri-supported install formats:

- **Windows NSIS** — passive install of the downloaded `.nsis.zip` after
  a click on **Install update**.
- **Linux AppImage** — same path; in-place replacement.
- **Linux `.deb` / `.rpm`** — managed by the system package manager.
  The Updates panel detects this and points to the GitHub releases page
  instead of pretending in-app updates work.
- **macOS `.app`** — in-place replacement of the application bundle from
  the downloaded `.app.tar.gz`. Works even though the build isn't
  Apple-notarized: the updater's integrity check uses our own Ed25519
  signature, separate from Apple notarization.

**Auto-check for updates** — off by default. Switch it on in **Settings →
Updates** and Loach asks the release server once per launch whether a newer
version exists. If one does, an **Update available** dialog opens with the
current and new version numbers, that release's notes, and **Update now** /
**Later**; nothing is downloaded or installed until you pick Update now.
The manual **Check for updates** button in the same panel works whether or
not the auto-check is on. On an install the updater can't patch, the panel
shows neither control — just a note to download the release manually and an
**Open releases** button.

**What's new** — every release includes a markdown notes file that
populates both the GitHub release body and the in-app **Updates** panel
when an upgrade is available.

Cryptographically signed with the Tauri updater's Ed25519 keys; signature
verification happens before the binary is replaced.

---

## 18. Storage and privacy posture

- **Everything except secrets lives in a local SQLite database** under the
  user's app-data directory. Foreign keys are on; backups round-trip
  schema constraints.
- **API keys, app-lock hashes** — OS credential store only (Windows
  Credential Manager / Linux Secret Service / macOS Keychain via the
  `keyring` crate).
- **No telemetry** — Loach makes no outbound network requests beyond
  the providers the user configures, the optional URL fetches the user
  triggers, the MCP servers the user wires up, and the in-app updater
  check against the GitHub releases endpoint.
- **CSP is locked down** — no remote scripts, no inline scripts, no eval.
  The Tauri global is disabled; the renderer talks to the backend only
  through registered commands.
- **File I/O is backend-owned** — every save / open dialog and the actual
  read / write happens in Rust. The renderer never knows the chosen
  path, so a compromised UI cannot read or overwrite arbitrary files.

---

## 19. Keyboard reference

Press `Cmd/Ctrl + /` at any time to see these shortcuts as an in-app cheat
sheet.

- `Cmd/Ctrl + K` — global search palette.
- `Cmd/Ctrl + N` — start a new chat.
- `Cmd/Ctrl + F` — find within the current chat transcript.
- `Cmd/Ctrl + U` — attach files to the current chat (opens the file picker).
- `Cmd/Ctrl + Shift + Backspace` (or `Delete`) — delete the current chat,
  after a confirmation.
- `Cmd/Ctrl + Shift + S` — show / hide the left sidebar.
- `Cmd/Ctrl + Shift + P` — show / hide the parameters panel.
- `Cmd/Ctrl + /` — open the keyboard-shortcuts cheat sheet.
- `/` (start of the composer) — open the slash-command palette.
- `Enter` — send the composer, or run the typed slash command.
- `Shift + Enter` — newline in the composer.
- `Tab` — in the command palette, complete the highlighted command.
- `Esc` — close the search or command palette, dismiss menus and dialogs,
  exit onboarding (with confirm on the provider step).
- Up / Down inside the search or command palette — move the active entry.

---

## 20. Platform support

- **Windows 10/11 x86_64** — NSIS installer, in-app updater.
- **Linux x86_64** — AppImage (with in-app updater), `.deb`, and `.rpm`
  (managed by the package manager).
- **macOS 11+ Apple Silicon** — `.dmg` install plus a `.app` bundle, with
  in-app updater. The build is **not Apple-notarized** (we don't subscribe
  to the Apple Developer Program), so first launch requires a one-time
  Gatekeeper bypass — see the README "Install on macOS" section. Intel
  Macs are not supported.

System requirements depend on the local model you pick (Loach itself is
small — a few hundred megabytes resident); Ollama's GPU requirements
apply when running local models.
