# Loach — Feature Documentation

A native desktop chat client for local and OpenAI-compatible language models.
Loach runs as a Tauri 2 app on Windows, Linux and macOS, stores everything
locally in SQLite, and keeps the OpenAI-compatible API key and the app-lock
hash in the OS credential store.

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
- **Auto-detected on launch** — Loach probes the base URL as soon as it
  starts, so pulled models appear in the model picker without a refresh. If
  Ollama isn't running, the picker says so and offers **Start Ollama**
  (below); the Models tab shows the connection error.
- **Test connection** — the Providers panel exposes a one-click probe that
  pings `/api/tags` and reports whether the daemon answered and how many
  models it lists, so the user can confirm a custom base URL works without
  leaving Settings.
- **Start Ollama** — when the daemon isn't answering, the model picker
  shows a **Start Ollama** button that launches it on demand and swaps in
  the model list once it responds. Errors surface in the menu itself.
- **Auto-launch Ollama** — an opt-in switch in **Settings → Providers**
  does the same thing at startup, if nothing is already running. Off by
  default (starting a background service is the user's call) and limited
  to a base URL that points at this computer — a remote Ollama isn't
  Loach's to start. The button above has the same limit: it refuses a
  base URL on another machine.
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
  plain text, never shipped to the renderer. Sent only over `https://`, or
  over `http://` to this computer (`localhost`, `127.0.0.1`, `::1`) — an
  `http://` server elsewhere on the network gets no key, so one that
  requires it answers 401.
- **Catalog listing** — fetched with the saved key, or without one when the
  base URL points somewhere other than the OpenAI default (local servers
  such as LM Studio and `llama-server` accept keyless requests). The Models
  tab shows the section only when the listing returned something, rather
  than spamming 401s.
- **Test connection** — calls the endpoint's `/models` listing with the
  stored key (when the rule above lets it be sent) and reports the model
  count (or a readable error) so the user can verify a base URL + key pair
  before opening a chat. Disabled while
  there's an unsaved key in the input.
- **Reasoning models** — OpenAI's o-series and GPT-5 refuse `max_tokens`
  and a non-default `temperature`. When a server turns a request down over
  either field, Loach resends it with `max_completion_tokens` in place of
  `max_tokens`, or without the temperature.
- **Context window** — these servers don't report their window and ignore
  `num_ctx`, so Loach assumes **32k** (32,768 tokens) unless the chat sets
  a context length (§8). The figure only sizes Library sources (§4.4) and
  the context usage bar (§2.10).

### 1.3 Model picker

Every chat shows a model dropdown in its header that lists both providers'
catalogs grouped by provider (**Ollama** and **API**; the API group lists
every model the endpoint offers — the menu scrolls, and typing a model's
first letters jumps to it). Switching a chat's model:

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
  or an MCP tool), the calls collapse into a single header above the
  answer — **Called <tool> tool** for one call, **Called N tools** for
  more — styled like the Thinking block. Expand it to
  see each call's name, arguments, and result (or error, *Denied*, or
  *No answer*).
  A call still open when the reply ends — you pressed Stop, or it failed —
  is marked *Interrupted*, saying whether it can have run: one stopped
  while running may still have finished (a workspace write that was under
  way completes on disk regardless).
  An MCP call that needs your approval shows an **approval card** above
  the block — server, tool, arguments, and **Allow once**, **Always allow
  <tool>** and **Deny** — and the reply waits until you answer (§9.2).
- **Metrics chip** — every finished assistant turn shows the completion
  token count, wall-clock time, and tokens/sec. Ollama reports the count
  itself; OpenAI-compatible endpoints do so only when they send a `usage`
  block, otherwise Loach counts streamed chunks. The rate falls back to
  wall-clock timing when the backend reports none.
- **Markdown + code highlighting** — `react-markdown` + `rehype-highlight`
  with GitHub-flavored markdown extensions. Tables, lists, footnotes, and
  language-aware syntax highlighting work out of the box.
- **LaTeX math** — formulas typeset with KaTeX, no opt-in required.
  `$$…$$`, `$…$`, `\(…\)`, `\[…\]` and ``` ```math ``` fences all render,
  and a `$$…$$` written on a single line is promoted to a centred display
  block. TeX that doesn't parse degrades to showing its own source (parse
  error on hover) rather than flashing an error, which keeps half-typed
  formulas quiet mid-stream. Applies to assistant replies in the transcript
  and Private Chat; other markdown, like release notes, never typesets
  math.
- **Currency-safe `$…$`** — `$` doubles as a currency sign, so a
  single-dollar span only typesets when it reads as math: the content must
  hug both delimiters, stay on one line, not follow a word character, and
  not be chased by a digit. "it costs $5 and $10", "between $5-$10" and
  "US$5" all stay prose, while `$x^2$` — the delimiter most models actually
  emit for inline math — renders with no settings hunt. `\$` always means a
  literal dollar sign.
- **Lazy engine** — KaTeX is a ~270 KB JS chunk plus a ~24 KB stylesheet and
  60 font files, all bundled into the installer like the rest of `dist/`.
  **Nothing is fetched over the network** — the window CSP
  (`default-src 'self'`) would block it if anything tried. What's deferred is
  only *when it's read from disk and parsed*: a dynamic `import()` fires the
  first time a message in that session actually looks like it contains math,
  so a launch that never renders a formula never pays for one. It reloads on
  the next launch — the deferral is per session, not a one-time install step.
- **Unicode symbol fallback** — always on, whether or not a message
  contains math: loose single-token TeX in prose (`\rightarrow`, `\alpha`,
  `\sum`) is rewritten to the equivalent Unicode character. It runs over the parsed
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
  bubble; **Pin this response** (§2.11), **Fork from here** (§2.6) and
  **Save to Library** (§4) on assistant replies, and **Save attachments to
  Library** on user prompts that carry files.

### 2.2 Composer

The input box at the bottom of every chat.

- **Multiline input** with Enter to send and Shift+Enter for newline.
- **Slash commands** — type `/` at the start of the composer to open the
  command palette and run chat actions, switch model, fetch a URL, and
  more without leaving the keyboard (see §2.9).
- **`+` menu** — **Add files** opens the file dialog (drag and drop also
  works anywhere in the window); **From Library** links saved texts, files,
  links and datasets to the chat — or type `#` in the message box (§4.3);
  **Add directory** gives the chat a workspace folder, and reads **Change
  directory** once it has one (§9.4).
- **Suggestion chips** — on the welcome hero screen of an empty chat,
  shortcuts seed the composer with starter prompts ("Explain a concept",
  "Write code", "Summarize a file", "Brainstorm").
- **Chip row** — the active persona and tone each show as a chip above the
  input, sharing the row with the attachment chips. Persona and tone are
  accent-tinted and stick across sends; file chips are neutral and leave on
  send, with a divider between the two groups. Click a chip's ✕ to clear it
  (swap persona or tone from the parameters panel). Clearing a tone clears
  it for *this* chat only — it's
  written as a per-chat override rather than an unset, which would fall
  straight back through to the **Settings → General** default and put the
  chip right back.
- **Send / Stop morph** — while a reply is streaming for the active chat,
  the send button becomes a stop button. Cancelling persists whatever has
  been streamed so far.
- **Drafts per chat** — unsent text and attached files stay with the chat
  (or the Space page) they were written in, so switching chats never
  carries them along. Drafts are kept in memory only; quitting Loach drops
  them.

### 2.3 Attachments

Drop any file up to **20 MB** into the composer. Loach handles three flavours:

- **Images** (PNG, JPEG, WEBP, GIF) — sent as base64 to vision-capable
  models alongside the text turn.
- **Text and code** (one of ~70 recognised extensions, plus anything with a
  `text/*` MIME) — read verbatim and inlined into the prompt as a fenced
  code block. UTF-16 files and legacy Windows code pages (Windows-1250 /
  -1252, picked by the UI language) are decoded, not just UTF-8.
- **Documents** — **PDF** (text-extracted via `pdfjs-dist`) and **DOCX**
  (extracted via `mammoth`).

Each text or document attachment is capped at **200,000 chars** (a cut PDF
also tells the model how many pages it got). The file chip flags
truncation; the model is also told inline.

Total inlined content per message is capped at **500,000 characters** across
attachments + URL fetches + the prompt itself. An attachment that only partly
fits is clipped with a note to the model (the chip shows no *truncated* flag
for this), and anything with no room left is listed by name in a trailing
footer so the model knows it exists.

Files Loach can't decode (legacy `.doc`, archives, binaries) are kept as
base64 in the transcript and announced to the model by name so it can ask
for a readable version.

Clicking an attachment chip opens a per-type preview without leaving the
chat:

- **Images** → lightbox with a **Save** button (clicking the dim backdrop
  closes it, matching standard lightbox behaviour).
- **PDFs** with original bytes retained → multi-page rendered preview
  (lazy per-page rasterisation via `pdfjs-dist`) with **Save**.
- **Text and code** → opens in the **Code canvas** (§11) with language
  highlighting and export (in Private Chat, the file-info card below).
- **DOCX, binaries, and older PDFs without raw bytes** → a file-info card
  with **Save**, so the user can still pull the attachment back out even
  when Loach can't render it inline.

### 2.4 Concurrency model

Loach runs **exactly one generation at a time across all chats** with a global
FIFO queue:

- Sending in a busy chat refuses the second submit (one in-flight per chat).
- Sending in another chat while one is running parks the request; the
  sidebar row shows a spinner while it waits.
- A waiting chat shows a **Waiting for other chats to finish…** banner in
  its transcript with **Respond now** to jump the queue and cancel the
  current runner (and **Cancel** to withdraw the request).
- A reply waiting on a tool approval card (§9.2, §9.4) keeps its turn, so
  other chats queue behind it until you answer the card — or use
  **Respond now** in a waiting chat, which cancels the waiting reply.
- A cancelled stream keeps whatever streamed before you stopped it; an
  errored one also gets a visible ⚠ error line, so a failed reply is never
  silently empty.

### 2.5 Chat list (sidebar)

- **Grouped by recency** — Pinned, Today, Yesterday, This week, Older.
- **Per-row indicator** — spinner while generating, accent dot for unread
  replies that finished (or failed) while you were in another chat.
- **Per-row menu** — **Pin this chat** / **Unpin**, **Label**, **Rename**,
  **Remove from folder** (when filed), **Move to archive**, **Delete**.
- **Right-click** anywhere on the row opens the same menu.
- **Spaces icon** marks chats that belong to a Space (not shown on pinned
  or forked chats, whose own icon takes the slot).
- **Colour labels** — tag a chat Red, Amber, Green, Blue, Purple or Pink
  from the **Label** submenu of any chat menu (sidebar row, chat header,
  or Space view). The colour renders as a dot at the start of the row in
  the sidebar and in the Space view. **No label** clears it.
- **Folders** — drag one chat row onto another to group them. Loach asks
  for a folder name and files both chats into a **Folders** section that
  sits between Pinned and the date groups (if the target already sits in a
  folder, the dragged chat joins that folder). Folders are flat — they never
  nest. A new folder opens expanded, and Loach remembers which folders you
  left open between launches.
  - Drop a chat on a folder to file it; drop it on a date caption (Today,
    Yesterday, …) to take it back out, or use **Remove from folder** in
    the row menu.
  - A filed chat leaves the date groups, but a pinned one still appears
    under Pinned as well.
  - The folder's own menu offers **Rename** and **Delete folder**.
    Deleting never deletes chats — they move back to the main list.
- **Archived** — a quiet footer row with a count appears whenever archived
  chats exist and opens **Settings → Archive** (§2.7).

Below 1080 px the sidebar gets out of the way on its own: opening a right
panel (code canvas or parameters) folds it to its icon rail so the
transcript keeps a usable width, and restores it when the right slot empties
again. A manual toggle always wins — flipping the sidebar yourself cancels the
pending restore.

### 2.6 Header actions (per chat)

- **Search in chat**, **Pin this chat** / **Unpin**, **Label**, **Rename**,
  **Move to archive** / **Restore from archive**, **Delete**.
- **Fork this chat** — clone the conversation into a new chat (same model,
  Space, sidebar folder, workspace folder, Library sources, instructions and
  parameters) so
  you can branch a tangent without disturbing the original.
  The fork carries a **"Forked from …"** badge in its header that jumps
  back to the source; the badge disappears if the source is deleted. Also
  available as **Fork from here** in an assistant reply's `…` menu (forks
  up to and including that reply) and via the `/fork` command. Forking
  waits for a running reply to finish. A fork cut before the last turn a
  compaction (§2.10) summarised leaves the summary behind and sends the
  turns it copied in full.
- **Export context** — opens a dialog with the transcript rendered as
  Markdown and a **Copy** button. A **Compact context** toggle in the
  dialog shows a summary written by the chat's model instead of the
  verbatim transcript (it needs at least six messages; your chat isn't
  changed). The verbatim Markdown is assembled in Rust and
  the compact one in the renderer; nothing is written to disk — paste it
  wherever you need it. Also reachable as `/export`.
- **Import context** — paste exported JSON/Markdown or any plain text;
  it's parsed into messages and appended to the current chat. A **Hide
  from transcript** toggle folds the imported messages into a single
  collapsed card instead of showing them inline — either way they're
  still sent to the model.
- **Search in chat** — Cmd/Ctrl+F-style find within the chat.

### 2.7 Archive

Chats can be archived (kept around but out of the main list). The Archive
lives in **Settings → Archive** and lets you:

- Open an archived chat. It stays interactive; the header shows an
  **Archived** pill so you know where you are.
- **Unarchive** to bring it back into the main list.
- **Delete permanently** from the archive.
- **Remove all** to permanently delete every archived chat in one step,
  behind a confirmation because it's irreversible.

Mass-archiving lives next door: **Archive all** on **Settings → Data** parks
every live chat before starting fresh.

Archiving a chat also unpins it, stops a reply it's still generating, and
closes it if it was open; **Undo** brings the chat back, but not its pin.

Archiving a chat raises a toast naming it with an inline **Undo**, held for
7 seconds (and longer while hovered), and the sidebar keeps a quiet
**Archived** row with a count whenever archived chats exist — so a mis-click
never reads as a delete. Unarchiving gets no toast: its result is visible in
the list.

### 2.8 Private Chat

A **dark-only, ephemeral chat surface** for conversations that should leave
no trace. Open it from the ghost icon in the title bar.

- **Nothing is persisted.** No session row, no message row, no metrics, no
  attachment store. The transcript lives entirely in memory and is wiped
  the moment the overlay closes (along with the picked model, persona,
  tone, per-chat instructions, and parameters panel state). Locking Loach
  (§13) ends the session the same way.
- **Ollama-only.** OpenAI-compatible providers aren't shown in the model
  picker — the data path for the cloud providers crosses too many
  intermediaries to honour the "leaves no trace" promise. Ollama's cloud
  models (`…:cloud` tags) are left out too, since Ollama runs them on
  ollama.com. When the Ollama base URL points at another machine, the
  overlay says so: messages go to the server at that address.
- **No tools.** Servers configured in **Settings → MCP** are not exposed
  to the model inside Private Chat, so a tool call can't side-channel the
  conversation out to a third party — and neither are the built-in tools
  (§9.3): the overlay has nowhere to show a call, its result or a PDF one
  makes. A Private Chat never gets a workspace folder (§9.4) either.
- **No canvas.** Code blocks keep **Copy** and **Export**, but can't open
  the code canvas (§11): it belongs to the regular window and would stay
  on screen after the overlay closes.
- **No backdrop / Esc close.** The overlay can only be dismissed by the
  explicit `X` in its header. The wipe is destructive; we don't want a
  stray click to throw away the conversation.
- **Regular chat is paused.** Opening Private Chat cancels any in-flight
  regular generation; the regular chat surface is non-interactive
  underneath until the overlay closes.
- **Same shaping layers as regular chats** — persona, tone (falling back to
  the default tone from **Settings → General** when not overridden), and a
  free-form per-chat instructions textarea, layered persona → instructions
  → tone. No **Custom instructions** from **Settings → General**, no Space
  context or Library sources, no `{{USER_NAME}}` substitution, no temporal
  preamble — those layers belong to persistent chats.
- **Parameters panel** — the Simple view of the regular panel (context
  length, model defaults, Thinking and Low VRAM toggles); there is no
  Advanced view here. Closes and wipes along with the rest of the overlay.

### 2.9 Slash commands

Type `/` as the first character in the composer to open the **command
palette** — a floating list that filters as you type. Arrow keys move the
selection, **Tab** completes the highlighted command, and **Enter** runs a
fully-typed command (or completes a partial one). **Esc** dismisses the
palette. Anything that isn't a recognised command is sent as an ordinary
message, so a prompt that happens to start with `/` is never swallowed —
and text that goes on with a space or a second slash (`// note`,
`/ aside`) doesn't open the palette at all. A command that takes no
argument refuses one (`/regenerate but shorter` errors rather than
dropping "but shorter"), and a command that fails leaves its text in the
composer to fix and run again.

Commands are grouped the way `/help` lists them:

- **Chat** — `/new`, `/clear`, `/rename <title>`, `/pin`,
  `/label <color|clear>`, `/folder <name|none>` (an existing folder by its
  exact name, else a new one), `/archive`, `/delete`, `/fork`,
  `/regenerate`, `/stop` (the reply running or queued in this chat, or a
  send still being prepared), `/copy [N]` (copy the last or Nth-latest
  assistant reply), `/find [text]` (open the in-chat finder), `/export`,
  `/import`, `/stats`, `/compact`, `/private`.
- **Model & persona** — `/model [name]`, `/persona [name]`,
  `/tone [name]` (matched by full or partial name; several matches show a
  list to pick from). Bare `/model` opens the model picker; bare
  `/persona` and `/tone` say which one is in effect. Where Ollama and the
  OpenAI-compatible endpoint serve the same model id, `/model ollama/<id>`
  or `/model openai/<id>` picks one. `/set <param> <value>` sets a
  generation parameter (§8) within the panel's own ranges, `/set reset`
  drops the chat's overrides, and `/unload` unloads the chat's Ollama
  model from memory.
- **Listings** — `/list models | personas | spaces | snippets | mcp |
  providers | memories`.
- **Prompts** — `/instructions [text|clear]` (set or clear the per-chat
  system prompt; on its own it shows the current one), `/snippet <name>`
  (expand a saved snippet into the composer).
- **Memory & Spaces** — `/remember <fact>`, `/forget <id|query>`,
  `/space <name>` (typed on a Space's page, it opens the other Space's
  page). Inside a Space the memory commands act on that Space's
  memory; outside one they act on the global list. `/remember` needs that
  memory turned on — the Space's memory toggle, or Global memories.
- **Tools & web** — `/tools` (list tools from enabled MCP servers),
  `/web-fetch on|off`, `/fetch <url>`, `/thinking on|off`.
- **App** — `/settings [tab]` (general, providers, features, tools,
  library, appearance, mcp, archive, data, security, updates, about),
  `/theme light|dark|system`, `/lock` (needs an app lock — §13), `/help`.

Above those sits a **Recent** group: the four commands you last ran, hoisted
out of their normal groups. The list is persisted (six names, in the settings
table) rather than session-scoped, so it's useful on the first `/` after a
restart instead of only once you've already run the command that launch.

`/clear` and `/delete` are destructive and route through a confirmation
dialog before they run. `/clear` also drops the chat's compaction summary
(§2.10) — your own instructions stay — and is refused while the chat is
being compacted.

### 2.10 Context usage and compaction

A slim **context usage bar** sits just below the message box once a chat
has messages. It shows how much of the model's context window the chat is
using — `used / total` tokens and a percentage — with a popover that breaks
the estimate down into the system prompt (a Space's instructions
included), project instructions (`LOACHFILE.md`), memories, sources (what
the next message will send of them, in full or as excerpts — §4.4) and
messages (attachments called out), plus what's left of the window. It's an
estimate, at about four characters per token (about one per character for
Chinese, Japanese and Korean).
On an Ollama chat the popover's **Expand context window** button doubles
this chat's context length. An OpenAI-compatible server ignores that
setting, so there the bar measures against the 32k Loach assumes (§1.2),
or the context length the chat sets, and the button isn't offered.

When a chat grows long, **Compact context** (the button in the bar's
popover, or the `/compact` command) summarises the older turns with the chat's own
model and tucks the summary into the system prompt. The summary doesn't
count as the chat's own instructions: it rides along with whichever ones
apply — the Space's, the chat's, or your Custom instructions (§16). The original messages
aren't deleted — they stay in the transcript for scrollback, marked with a
compaction divider, but are dropped from what the model sees on the next
turn so the freed context goes to new conversation. The popover button is
only enabled once a chat is large enough to benefit (at least six messages
and a quarter of the window in use); `/compact` checks only the
six-message minimum.

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
  Data backups (§14).

### 2.12 Sharing a message

**Share** in any message's `…` menu opens a dialog with two modes.

- **As text** — the message as written. **Copy** puts it on the clipboard,
  or hand it to **Facebook**, **X**, **Reddit** or **LinkedIn**: Loach
  opens that network's composer in your browser with the text pre-filled,
  trimmed to the length each one accepts. Facebook's share link needs a
  URL, so it carries Loach's GitHub page with your text in a separate
  quote field. The clipboard always gets the full text.
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
sources, and a memory store. Every chat created inside a Space inherits that
context.

### 3.1 What a Space holds

- **Instructions** — a system prompt that *overrides* any global or per-chat
  prompt when set (the Space is the user explicitly opting into space-level
  guidance).
- **Reference sources** — on the **Sources** tab: files uploaded to the
  Space (text files, PDFs and DOCX documents; **20 MB** per file, **200 MB**
  total per Space) and Library items or datasets linked to it (§4). Every
  chat in the Space gets them, as full text or as the most relevant
  excerpts — the tab shows how much of the context window they take, and the
  Space's mode is set on its **Settings** tab (§4.4); images ride along with
  the user turn. A switch on
  each source keeps it in the Space without using it. Uploads in formats
  Loach can't read (spreadsheets, archives, legacy `.doc`) are kept but
  marked **unreadable** and never sent.
- **Memory** — auto-extracted one-line facts about the user (see §3.3).
- **Default provider and model** — pinned per-Space so a "code review"
  Space can always start in a different model than a "writing" Space.

### 3.2 Lifecycle

- Create from the **Spaces** library (**New Space**).
- Edit name and description from the Space's `⋯` menu → **Edit details**;
  instructions live on their own tab, and the default model, memory
  auto-save and source mode together on the **Settings** tab.
- Open a Space to see its detail view — **Chats**, **Instructions**,
  **Sources**, **Memory** and **Settings**, each on its own tab. Each chat row
  in the Chats tab exposes the same `…` action menu as the main sidebar
  (Pin this chat / Unpin, Label, Rename, Move to archive, Delete).
- **Delete Space** (same `⋯` menu) removes its instructions, uploaded
  sources and memories; Library items linked to it stay in the Library. Its
  chats stay, but leave the Space.

### 3.3 Space Memory

Per-Space auto-memory, on by default for a new Space. After every
assistant reply in a Space, Loach
fires a one-shot LLM call (against the same provider/model the user is
chatting with) and asks it to extract durable, single-sentence facts about
the user. The existing memories are shown to the extractor numbered, so it
can also **update** one that changed (a reversed preference, a move) or
**remove** one that no longer holds, instead of piling up contradictions.
New facts are deduped locally too (token overlap that also checks word
order, so "prefers A over B" is not mistaken for "prefers B over A").
The extractor is told that what you ask for in a chat is a task, not a
fact about you, and a "fact" that just reports a request ("User requested
a Python file…", "Is asking how to…") is dropped locally as well. It reads
what you typed, not the files you attached or the pages Loach fetched for
the turn — text you didn't write isn't a fact about you, and it's where an
injected "remember that I…" would hide. Facts you added yourself (in the
Memory tab or with `/remember`) are shown to it as read-only: it can't
rewrite or remove them, only avoid repeating them.

- **Toast for every change** — "Saved to memory" / "Updated memory" /
  "Removed memory" pills with the fact and an **Undo** button.
- **Memory tab** — review, edit, or delete any row, add facts manually,
  search, see when each was saved and jump to the chat it came from, or
  clear the whole list — while a search is typed, **Clear** removes only
  the facts it shows. Facts too old to fit the prompt (below) are marked
  *not sent*.
- **Per-Space toggle** — on the Space's **Settings** tab (the Memory tab
  shows whether it's on); turn extraction off without wiping existing rows.
  Existing memories continue to ride along in every chat; automatic
  extraction, the Memory tab's **Add** and `/remember` stop.
- **Coverage** — a reply that finishes while more messages are queued, or
  an extraction aborted by the next send, is parked and folded into the
  next extraction in that chat (up to three turns per run). Parked turns
  are held in memory, so quitting Loach drops them.
- **Caps** — the newest memories go into both the chat prompt and the
  extractor prompt, up to 60 of them and about 6,000 characters (roughly
  1,500 tokens) per list, so every fact the model sees is also shown to the
  extractor. A fact the extractor saves or rewrites is rejected if
  longer than 280 chars; facts you add or edit yourself aren't capped. One
  run saves at most five new facts and removes or rewrites at most three
  existing ones, and the removals' and rewrites' toasts are shown last, so
  their **Undo** stays on screen. **Undo** on a removal puts the fact back
  where it was, with its original date.

Memories are silently injected into the system prompt of every chat inside
the Space as a `--- Space memory ---` bulleted list. Cancel / error turns
never trigger extraction, since the assistant text is incomplete.

### 3.4 Global Memory

Settings → Features → **Global memories** (off by default) extends the
same mechanism to chats outside any Space: after each reply the extractor
runs against the global list, and a `--- Global memory ---` block is
injected into every chat, inside or outside a Space (the prompt tells the
model that Space facts win on conflict). Space chats keep writing to their
own Space memory; the global facts are shown to their extractor as
read-only context so they aren't duplicated. **Manage global memories**
opens the same editor as a Space's Memory tab. Turning the setting off
stops both extraction and injection. Global facts go with every chat
whichever provider it uses, so one learned talking to a local model also
reaches a cloud one.
Private Chat never reads or writes memory of either kind.

---

## 4. Library

The **Library** (sidebar) keeps the texts, files and links you give your
models in one place — saved once, used in any chat or Space. Sources are
linked, not copied: edit an item in the Library and every chat and Space
using it sees the new version on its next message.

### 4.1 What it holds

The page has a tab for each kind, and the button in the header adds to
whichever tab is open. The page itself lists everything; to search the
Library, use the search palette (**Cmd/Ctrl+K**, §10), where `in:library`
narrows the results to Library items and datasets.

- **Texts** — written or pasted in the app (**New text**; Markdown works),
  editable at any time.
- **Files** — **Upload files**, or drop them anywhere on the page: text and
  code files, PDFs and Word documents (their text is extracted, as for
  attachments — §2.3) and images. **20 MB** per file; formats Loach can't
  read (spreadsheets, archives, legacy `.doc`) are turned away with a note.
- **Links** — **Add link** fetches a web page once and keeps its text as a
  dated snapshot. **Refresh** fetches it again; **Open in browser** opens
  the original. The fetch follows the web-fetch rules (§9.1): http and https
  only, no `localhost` or private-network addresses, and text pages only — a
  link to a PDF has to be downloaded and uploaded under Files. Adding a link
  that's already in the Library refreshes the copy you have.
- **Datasets** — named groups of texts, files and links, like "Thesis
  research", so a whole set attaches in one click. Each dataset has its own
  page (with a breadcrumb back to the Library) for adding, uploading straight
  into it, and removing items. Items stay in the Library — a dataset only
  groups them, and an item can sit in several.

A text body keeps up to **200,000 characters**; anything longer is cut,
marked **Truncated**, and ends with a note telling the model it's
incomplete. Uploading a file whose content is already in the Library asks
before storing it twice.

### 4.2 Managing items

- Click an item to **preview** it: the full text (or image), when it was
  added or fetched, and the datasets it's in. The title is renamed in place
  (Enter saves, Esc cancels).
- Each item's `⋯` menu has **Preview**, **Edit** (texts), **Refresh** and
  **Open in browser** (links), **New chat**, **Add to dataset**, **Add to
  Space** and **Delete**.
- Tick several items — across tabs, or a whole tab with **Select all** — to
  act on them together: **Add to dataset** (a new or an existing one), **Add
  to Space**, **New chat**, **Delete**.
- **Delete** asks first and names the datasets, Spaces and chats that use the
  item, directly or through a dataset; it's removed from all of them.
  Deleting a dataset keeps its items.
- **Save to Library** from elsewhere: a reply's `…` menu saves the reply as a
  text, a user message's menu saves its attachments, and a file uploaded to
  a Space can be saved from its `⋯` menu on the Space's **Sources** tab.
  Saving something that's already there just says where it is.

### 4.3 Using sources in a chat

- In the composer, **`+` → From Library** opens a picker of datasets and
  items, or type `#` and a few letters to pick one inline (`Tab`, or the
  arrow keys and `Enter`, attaches it; `Esc` dismisses the list). Picked on
  the welcome screen, sources attach to the chat once it's created.
- **New chat** — on a text or dataset card, a dataset page or a selection —
  starts a new chat with them already attached.
- Attached sources show as chips above the message box, with ✕ to remove
  one. A chat in a Space also gets the Space's sources (§3.1), shown
  alongside but managed on the Space's **Sources** tab.
- Forking a chat (§2.6) keeps its sources. Private Chat (§2.8) has none.

### 4.4 How sources reach the model

The **Sources** chip next to the message box sets how this chat uses them
(the same choice sits on a Space's **Settings** tab, and a chat in a Space
follows it until you pick something else):

- **Auto** (default) — the full text while all the sources fit in half the
  context window, the most relevant excerpts once they don't.
- **Full text** — always the whole text. If it can't fit (sources may take
  up to about 80% of the window) it's cut short, and the reply's sources
  chip says so.
- **Excerpts** — always search: for each message, the passages most
  relevant to it (and to your previous question, so a short follow-up still
  finds its subject) are added to that message, up to about a quarter of the
  window. They're picked again for every message: they aren't saved into
  your message or sent again on later turns.

New Spaces start on **Auto**. Spaces created before Loach 1.6 — and those
restored from an older backup — start on **Full text**, which is what they
did before (their chats follow it); switching them to **Auto** is up to
you.

Full text goes into the system prompt and stays the same from turn to turn,
so a local model's prompt cache keeps it. Image items are attached to the
message as images, for vision models. The window is the chat's context
length (§8); the context usage bar (§2.10) counts what the sources will
actually cost. An OpenAI-compatible server picks its own window, so for
those chats Loach assumes 32k (§1.2); set the context length to the
model's real window if it differs: it isn't sent, but it's what sources
are sized by. When full text has to leave something out, the
chat's own sources go in first and the Space's after them; any source that
didn't fit is named in the reply's sources chip.

Every reply that drew on sources carries a chip above it — "Read 3 sources
in full" or "Used 6 excerpts from 3 sources". Expand it to see which
sources (click a Library one to preview it) and the excerpts themselves;
warnings show there too, such as sources cut to fit or an embedding model
that couldn't be reached.

### 4.5 Search by keyword and by meaning

Every text source is split into passages of about 1,200 characters and
indexed for **keyword search** the moment it's added — no setup, no
network. Accents are folded, so `gesla` finds `gęślą`. Chinese, Japanese and
Thai text isn't split into words, though, so keyword search rarely matches
it; use an embedding model for those languages.

**Settings → Library** adds an **embedding model** for **search by
meaning**, which finds passages that answer a question even when they don't
share its words. It runs on Ollama — with suggested models
(`embeddinggemma`, `embeddinggemma-2:270m` — newer and better with code, on
a recent Ollama — `qwen3-embedding:0.6b`, `bge-m3`, `nomic-embed-text`) to
**Download & use** in one click — or on the OpenAI-compatible endpoint from
**Settings → Providers** (`text-embedding-3-small` / `-large`). Indexing runs
in the background, and keyword search keeps working meanwhile. The Library
header and Settings show where it stands: **Keyword search only** without a
model, **Indexing n / m**, **Search by meaning** once done, or **Embedding paused** with the reason (and **Retry**)
when the model can't be reached — searches then fall back to keywords and
the reply's sources chip says so. After a message's search couldn't reach
the model, the next minute's messages go straight to keywords instead of
each waiting on it. A passage the model refuses or fails on by itself is
set aside for keyword search rather than holding up the rest.

Changing the model, or the server it runs on (the base URL), re-embeds
every source. **Rebuild** re-embeds everything too, for example after
replacing a model with a new version under the same name.

The two rankings are merged; when nothing matches at all, the model gets
the opening part of each source instead.

With an OpenAI-compatible embedding endpoint, the text of your sources —
and of each message that searches them, in chats with a local model too —
is sent to that endpoint. With Ollama it stays on your machine.

---

## 5. Snippets

A **Snippet** is a saved prompt with an optional pinned provider/model. Live
in the **Snippets** sidebar tab.

- **Create** with title + prompt body. Optionally pin to a specific provider
  and model so "Run" always starts a chat there.
- **Run** — opens a fresh chat (with the pinned model if set) and primes the
  composer with the snippet's prompt. The user can edit before sending.
- **Save a prompt you already sent** — the `…` menu on any of your own
  messages offers **Save as Snippet**, which prefills the editor with that
  text.
- **Library view** — tile grid sorted by recency, with the static-variables
  panel (§5.1) above it.
- **Run / Edit / Delete** behind a per-tile `⋯` menu.

### 5.1 Snippet variables

Snippet bodies can contain `{{PLACEHOLDER}}` variables (uppercase names)
that get filled in when the snippet is expanded:

- **Static variables** — reusable key/value pairs defined once in the
  Snippets library (e.g. `{{TEAM_NAME}}` → "Engineering"). They're
  substituted automatically every time a snippet that references them is
  run. The built-in template variables (`{{USER_NAME}}`,
  `{{CURRENT_DATE}}`, …; see §16) are reserved and can't be redefined.
- **Prompt-on-use placeholders** — any `{{PLACEHOLDER}}` left unresolved
  after the static pass opens a small fill-in dialog when you run the
  snippet. Your answers are remembered per snippet for next time.

---

## 6. Models

The **Models** sidebar tab is a full management surface for the local Ollama
catalog plus a read-only listing of the OpenAI catalog.

### 6.1 List view

- Tiles for every installed model: family and on-disk size. Parameter
  size, quantization and format show in the editor header.
- **Pull model** — type a tag and press **Pull**; an inline chip shows the
  current status line and a progress bar, and can be stopped.
- **Refresh** — re-queries `/api/tags` and the OpenAI listing.
- **Open** any Ollama model to edit it in the **Models editor** — click
  the tile, or **Customize** in its `⋯` menu.

### 6.2 Models editor

For a single Ollama model, the editor lets you:

- **Inspect** the system prompt, the prompt template and the parsed
  PARAMETER block, plus the live Modelfile behind **Show live Modelfile**.
- **Edit** any of those fields in the form.
- **Save as new model** writes a derived model via `POST /api/create`
  (with a **Preview Modelfile** toggle) under the tag you type — a new
  `<name>-custom` tag is suggested. If a model with that tag already
  exists — the base model itself included — Loach asks before Ollama
  replaces it; to keep the original to revert to, save under a tag that
  isn't taken.
- **Duplicate…** (in the tile's `⋯` menu on the list view) — copy under a
  new tag without changes, asking first if that tag is taken.
- **Delete** — irreversible removal of the local copy.
- **Allow thinking step** — per-model override for the Thinking toggle.
  Sits between the Modelfile default and per-chat overrides. Remembered
  until Loach restarts.
- **New chat** pre-selected to this model.

### 6.3 Modelfile guardrails

The **Save as new model** form refuses to compile a Modelfile that would inject
additional directives via a malicious base tag, system block, or template
block. The base tag may use letters, digits, `.`, `_` and `-` in any number
of `/`-separated segments (so a Hugging Face pull such as
`hf.co/user/repo:Q4_K_M` works), plus one `:tag` suffix — no whitespace or
quotes. SYSTEM and TEMPLATE bodies are rejected
if they contain `"""` (which the Ollama parser would treat as an early
block-end).

---

## 7. Personas and tones

Two style layers that compose with the chat's system prompt at send time:

### 7.1 Personas (role)

Pick from a curated list of preset roles that pre-pend a system prompt:

- **None** — no persona, uses the user's instructions only.
- **Code Reviewer** — bug hunts, security checks, blunt PR feedback.
- **Writing Editor** — tighten prose without flattening voice.
- **Brainstorm Partner** — diverge first, converge later, pushes back.
- **Explain Like I'm 5** — plain language and concrete analogies.
- **Translator** — accurate translation that preserves tone and idiom.

Picked from the parameters sidebar or with `/persona`. Per-chat, and not
persisted across launches by design: the persona text is layered into the
system prompt at send time and never written to the chat, so after a
restart you pick it again.

### 7.2 Tones (style)

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

## 8. Generation parameters

Every chat has a slide-out **parameters panel** on the right. Two modes:

- **Simple** — context length, Thinking toggle, Low VRAM toggle, persona,
  tone, and the per-chat **Additional instructions** textarea. The view
  stays terse on purpose so the common knobs are reachable without
  scrolling.
- **Advanced** — adds **temperature**, top_p, top_k, min_p, max tokens,
  repeat_penalty, frequency and presence penalties, GPU layer count, and
  seed.

**Private Chat** (§2.8) reuses the Simple view and sends exactly the values
it shows: the merge below, minus the per-model preferences (layer 4).

The parameter merge order, top to bottom (later layers win):

1. **App defaults** — universal fallback (temp 0.7, top_p 0.95, etc.).
2. **Global Thinking default** — the **Settings → Features → Thinking**
   switch (Ollama only).
3. **Model defaults** — parsed from the Ollama Modelfile's PARAMETER
   block; cached after the first chat with that model.
4. **Per-model preferences** — currently the Models-editor Thinking
   toggle (kept until Loach restarts).
5. **Per-session overrides** — what the sliders in this panel save.
6. **Global app overrides** — the **Settings → Features → Low VRAM mode**
   pin, which forces `low_vram: true` on every Ollama request.

A **Reset to defaults** button below the sliders (labelled
**Reset to model defaults** when the model ships Modelfile defaults) clears
the per-session overrides and falls back to the merged defaults.

### 8.1 Thinking toggle

Only meaningful for Ollama models whose `capabilities` include `"thinking"`.
Sets the `think` parameter on `/api/chat`; ignored by OpenAI providers.
The default for new chats comes from **Settings → Features → Thinking**.

### 8.2 Low VRAM toggle

Ollama-only. Forces smaller batches and a leaner KV cache. The per-chat
toggle is overridden when **Settings → Features → Low VRAM mode** is on —
the panel shows the toggle pinned and disabled with a pointer back to the
setting.

---

## 9. Tools

Capabilities Loach offers to the models. Opt-in in **Settings → Tools**
(MCP servers in **Settings → MCP**).

Whichever tools a model uses, one reply gets at most 10 rounds with the
model: tools can run in the first nine, and the last round goes out
without tools, so a model still reaching for one answers with what it has; if it asks for tools anyway,
they aren't run and the reply ends with "Stopped after 10 tool-use turns".
Each tool result the model gets back is capped at 32 KB, with a note
saying so — the chat shows the whole result (up to 256 KB for an MCP
tool).

### 9.1 Web fetch

When a prompt contains an `http(s)://` URL, Loach downloads the page,
strips HTML to readable text, and appends it as a fenced block.

- **Off by default** — Loach is offline-first; opt in to make outbound
  HTTP calls.
- **Per-message cap of 5 URLs**, deduped.
- **30 s total timeout** per URL, **10 s connect timeout**.
- **5 MB body cap** — a longer page is cut there and marked truncated —
  and ~12,000 chars of extracted text per fetch.
- **SSRF guard** — only `http`/`https` schemes; the resolved IP must not
  land on loopback, RFC1918 private ranges, link-local, carrier-grade NAT,
  or another reserved range. A hostname that DNS-resolves to a private
  address is rejected. Redirects are walked manually and re-screened per hop.
  Loach connects straight to the screened address and never through a
  proxy (`HTTP(S)_PROXY` or the system's), since a proxy would look the
  host up again itself.
- **A failed URL doesn't block the send** — the reply's tool-call block
  shows the failure and why, and the model gets a short
  `Failed to fetch <url>: …` stub so it knows Loach tried.
- **Shown on the reply** — the URLs Loach fetched for a turn appear as
  small chips on the assistant message.

### 9.2 MCP (Model Context Protocol)

Loach speaks two MCP transports. Configure servers in **Settings → MCP**.

- **Streamable HTTP** — a `https://…` endpoint plus optional headers
  (typically `Authorization`). URLs are validated (the scheme must be
  `http`/`https`, and link-local cloud-metadata addresses are refused;
  `localhost` and private LAN addresses are allowed, since self-hosted
  servers commonly live there). Headers go through size and character
  checks, each response is capped at 4 MiB, and the per-request
  timeout is 30 s. Like web fetch (§9.1), Loach connects to the screened
  address directly, never through a proxy, and doesn't follow redirects.
- **Local process (stdio)** — a command (`npx`, `uvx`, `node`, or a full
  path), one argument per line, and optional `NAME=value` environment
  variables layered over Loach's own. Loach starts the program and
  speaks newline-delimited JSON-RPC over its pipes — the way most
  published servers ship. It starts in your home folder, so a relative
  path in its arguments means the same thing however Loach was launched.
  The process stays running between turns. When
  the server is disabled, edited or deleted, Loach closes its input and
  gives it two seconds to exit, as the MCP spec asks; one that doesn't is
  stopped together with every process it started, such as the `node`
  behind `npx`, while one that exits by itself keeps what it deliberately
  left running (the browser `mcp-remote` opens to sign in, say). When Loach
  itself exits, servers are stopped at once. Startup is allowed 60 s
  (first-run package downloads) and each request 30 s; a request that runs
  out of time fails, but the server keeps running — it may still be working
  on it — and is told the result is no longer wanted
  (`notifications/cancelled`), as it is when you press **Stop** mid-call.
  A server that leaves two requests in a row unanswered counts as hung,
  and the next call starts it afresh.
  A single reply over 4 MiB fails that call only — the server keeps
  running, and the model is told to ask for less at a time. An error reply
  (bad arguments, an unknown tool) likewise fails only that call.
  When the process exits or stops accepting input, **Test connection**
  quotes the last lines of its stderr so a failed launch says why (a
  timeout doesn't include them). In a chat the error stops short of the
  stderr — it can print anything, keys included, and the chat's text goes
  to the model and into exports — and the full text is in Loach's log. On Windows a bare `npx` resolves to
  `npx.cmd` through Loach's own `PATH`/`PATHEXT`, so commands work as
  typed; a `PATH` set in the server's environment isn't used for that
  lookup. On macOS and Linux the server gets the `PATH` your login shell
  builds — the one a terminal sees, read once per launch — followed by
  Loach's own, so tools installed through Homebrew, nvm or `~/.local/bin`
  are found even when Loach was started from the Dock or an app menu. A
  `PATH` set in the server's environment replaces both.

On either transport, a tool call whose server reports progress on it
(`notifications/progress`) gets a fresh 30 s with each report, up to 10
minutes in all, so a long tool that says it's still working isn't cut off.

For each server:

- **Display name** — the label shown in menus.
- **Enabled toggle** — disable without deleting.
- **Test connection** — runs `initialize` + `tools/list` without
  persisting and reports the server name, protocol version, and tool
  list.
- **Ask before each tool call** — the per-call approval switch, on by
  default (see below).

**Running a local program needs consent.** Testing a stdio configuration,
saving a new one switched on, changing its command, arguments or environment,
and turning a disabled one on each raise a native OS dialog first. It shows
the program and each argument on a line of its own (quoted when it
contains spaces) and the environment variables with their values — except
variables whose names say they hold a credential (`…TOKEN`, `…_KEY`,
`…SECRET`, `…PASSWORD`, `…AUTH…` and the like), which read *value hidden*.
Variables that change what runs (`PATH`, `NODE_OPTIONS`, `PYTHONPATH`,
`LD_PRELOAD`, package-index settings and the like) are always shown in
full. On Windows, when a bare command such as `npx` is found on `PATH`,
the dialog also names the file that will run (`…\nodejs\npx.cmd`). A command
line too long to show in full is refused rather than cut short, and so are
control characters and invisible or text-reordering Unicode anywhere in the command, arguments or environment, and variable
names that aren't plain ASCII. **Cancel** is the dialog's default button,
so pressing Enter declines; only clicking **Start server** starts the
program. The dialog is raised by the Rust side, not by the web view, so a
compromised renderer can't get a program run without a person clicking
through it. Snapshot imports store stdio servers **disabled** for the
same reason; enabling one in Settings raises the dialog. Saving a server
switched off doesn't ask; turning it on does. Approved command lines are
remembered for the rest of the session, so a test followed by a save asks
once. The dialog guards changes, not every launch: after a restart, an
enabled server you already approved starts without asking — though
**Test connection** asks again. When **Ask before each tool call** is off,
the dialog says so: agreeing to run the program then also means its tools
run unasked. Turning it off later on a server you already approved doesn't
ask again. A server's name is shown in the dialog too, so it follows the
same rules: one line, at most 100 characters, nothing invisible.

Environment variables are treated like headers: they hold API keys, so
they are scrubbed from exports, exactly like HTTP headers. Arguments are
exported as typed, except a URL's credentials (the password in
`postgresql://user:…@host`, a token before the `@`, a `?api_key=` value),
the value of a flag like `--token` or `--api-key=…`, and an environment
assignment or header whose name says it holds a credential
(`-e GITHUB_TOKEN=…`, `--header "Authorization: …"`), which read
`REDACTED`. An HTTP server's URL loses its credentials and every query
value the same way. Re-enter them after an import. An environment
variable is still the better place for a secret.

#### Per-call approvals

By default every MCP tool call pauses the reply and shows what the model
wants to run — server, tool, and the arguments — with three answers:

- **Allow once** — run it this time.
- **Always allow `<tool>`** — run it, and stop asking for this tool on
  this server. The choice is stored on the server row and listed in its
  editor under *Always allowed*, where **Ask again for all** clears it
  once you save the server. It's an answer about that program or
  endpoint: saving the server with a different command, arguments,
  environment or URL clears the list.
- **Deny** — the tool does not run. The model is told the user declined
  and continues without the result.

A prompt left unanswered for 10 minutes doesn't run either: the call is
marked *No answer*, and the model is told nobody answered — not that you
declined. **Stop** cancels the reply as usual. While the card waits, other
chats queue behind the reply (§2.4); if it's waiting in a chat you aren't
looking at, a notice says so with a way there, and a chat queued behind it
names the chat it's waiting on. Turning **Ask before each tool call** off on
a server skips the prompt for all of its tools; the server row shows an
*Auto-approve* badge so the exception stays visible. Built-in tools
(§9.3) never ask — they run in-process, with no network access — except
the four workspace file tools that change files (§9.4), which ask unless
you've allowed them for the chat.

### 9.3 Built-in tools

A set of small, local utilities the model can call mid-answer through the
same tool-call loop as MCP. Each has its own toggle in **Settings →
Tools** and all of them are **off by default** — turn on only what you
want a given model to reach for. They run entirely in Rust on your machine
(no network, no disk writes beyond a PDF you ask for). The one exception is
the workspace file group in §9.4, which does touch the disk — inside a
folder you pick. None of them is offered inside Private Chat (§2.8).

- **calculate** — evaluate arithmetic, trig, functions, and constants;
  results carry 12 significant digits (as do **unit_convert**'s).
- **datetime** — parse, format, and do arithmetic on dates/times, with
  timezone conversion (a time without an offset is read in the zone the
  model names, UTC by default) and business-day counting. Differences
  count whole periods elapsed — a year only once the same date comes
  round — and days as wall-clock days in the chosen zone.
- **count** — count characters (Unicode scalar values), user-perceived
  characters (graphemes — an emoji with a skin tone, a flag or an accented
  letter counts once), bytes, words, lines, or substring hits.
- **hash** — SHA-224/256/384/512 over UTF-8, hex, or base64 input.
- **uuid** — generate v4 or v7 UUIDs (up to 100 per call).
- **base64** — encode/decode with the standard or URL-safe alphabet.
- **json** — validate, pretty-print, or pull values out by JSON Pointer,
  keeping object keys in their original order.
- **unit_convert** — convert between units across nine categories (length,
  mass, volume, speed, time, area, energy, pressure, temperature).
- **diff_text** — unified diff between two strings, by line, word, or
  character.
- **sort** — sort lines (lexical, natural, or numeric; reverse / unique).
- **ip** — CIDR membership checks and subnet info.
- **pdf** — generate a downloadable PDF from a structured spec (headings,
  paragraphs, lists, tables, page breaks), up to 200 pages. The result
  lands in the chat as a previewable, savable attachment. The bundled font
  covers Latin-script text only: Cyrillic, Greek, CJK and emoji print as
  `?`, and the tool tells the model how many characters that hit.

Calls render in the collapsible tool-call block described in §2.1.

### 9.4 Workspace files

Give a chat a folder and the model can work in it — read the project,
search it, and make changes — the way a coding assistant does, minus the
shell. Click the **+** button next to the message box and choose **Add
directory** (the same menu's **Add files** attaches file contents to one
message instead; the two are not variants of each other). A chat needs
its first message before it can have a folder, and the picker refuses a
whole drive (`C:\`, `/`) and Loach's own data folder, whose `loach.db`
holds every chat. For the rest of
the chat the message box reads "Working in *folder*" just above where you
type; click the folder's name to open it in your file manager, or remove
it with the ✕ beside it. Picking a folder also switches
on **Workspace files** in **Settings → Tools** if it was off, and the
notice says so if that switch is later turned off again — while it's off,
the model gets neither the tools nor
the folder's note and `LOACHFILE.md`. While a reply is running in the
chat, the folder can't be changed or removed — that turn keeps the folder
it started with. Forking a chat carries the folder over; exports and
imports never do — a path means nothing on another machine. If the folder
is later moved or deleted, the notice still shows it but the model gets no
folder tools and no project instructions until you pick the folder again.

Eight tools appear in the model's catalogue only while a chat has a
folder; without one the model never sees them. All paths are relative to
the folder, and nothing outside it is reachable: absolute paths and `..`
are refused up front, and every path is resolved through symlinks and
checked against the folder again before it is used, so a link pointing
elsewhere is refused too — as is a link whose target doesn't exist, since
writing through it would create that target wherever it points. Deleting
or moving a link acts on the link itself, never on what it points to.
Names that would be misread are refused as well: control characters and
the text-direction override and isolate characters anywhere (a
right-to-left override can make `txt.exe` look like `exe.txt` on the
approval card), and on Windows a `:` (a hidden data stream such as `setup.exe:Zone.Identifier`), a reserved
device name (`CON`, `nul.txt`, `COM1`) or a name ending in a dot or a
space — Windows tools can't open or delete those afterwards. A path that
reaches a file through its Windows 8.3 short name (`IMPORT~1.MD` for
`important-notes.md`) is refused too, so the approval card names the file
that would actually change.

- **list_directory** — tree of a directory, two levels by default, with
  dependency and build directories (`node_modules`, `target`, `.git`, …)
  shown but not descended into, and links marked rather than followed.
- **find_files** — locate files by name with a glob (`*.rs` anywhere,
  `src/**/*.test.ts` by path).
- **read_file** — contents with line numbers, paged for long files.
- **search_files** — regex search across contents, with file and line.
- **write_file** — create a file or replace one whole.
- **edit_file** — replace an exact snippet; an ambiguous match is refused
  unless the model asks to replace every occurrence, which the approval
  card points out.
- **move_file** — rename or move a file or directory; never overwrites.
  A rename that only changes case (`readme.md` → `README.md`) works on
  Windows and macOS too.
- **delete_file** — remove one file or one empty directory per call.

`find_files` and `search_files` go at most eight levels below the
directory they start from. When a walk stops above deeper directories,
the result says so, so the model can point `path` at a subdirectory
rather than conclude the file isn't there. Other limits: `read_file` and
`edit_file` handle files up to 4 MB, a write may be at most 1 MB and one
edit may grow a file by at most 1 MB, `search_files` skips files over
512 KB and stops after 2,000 files or 100 matches, `list_directory` stops
at 500 entries and `find_files` at 200 results — each says so when it
stops early. Both searches also give up after looking at 50,000 entries.

The four that change files ask you first, unless you've allowed that tool
for the chat. The consent card shows the change itself rather than raw
arguments: the contents of a write — saying whether it creates a new file
or replaces an existing one, and how big that one is — a `-`/`+` diff for
an edit, `from → to` for a move, and a red warning for a deletion. The
path is shown in full. In a diff, runs of unchanged lines are folded down
to three lines of context around each change, and when an edit adds or
removes the line break at the end of its text, the line is marked *no line
break after this* — without one, the file's next line joins it. A long
write is cut at 20,000 characters in the card and a long diff at 400 rows
(with a count of the rows removed and added below the cut), each with a
**Show all** link — the whole change is still what gets applied. Characters
that would otherwise display as nothing or reorder the text around them
(zero-width spaces, text-direction marks, control characters) are drawn in
paths and contents as visible `U+…` tags, so what you approve reads the way
it will be written.

**Allow once** runs that call;
**Allow … for this chat** stops asking for that tool in this chat until
you change or remove its folder, delete the chat, switch the workspace
tools off, or quit Loach (the grant is kept in memory, is tied to the
folder it was given for, and covers only Loach's own tool — never an MCP
server's tool of the same name). It never covers a place git runs
commands from the next time you use it, so changes there always ask:
anything inside a `.git` directory (which also shows in no `git status`
or diff), the hook folders `.husky` and `.githooks`, a
`.pre-commit-config.yaml`, and any folder laid out as a bare repository
(`HEAD` beside `objects` and `refs`). **Deny** tells the model to carry on
without it. Line endings are preserved: editing or overwriting a CRLF file
keeps it CRLF.

Writes and edits replace the file rather than rewriting it in place. A
file that is also hard-linked from elsewhere — a pnpm or uv package store,
say — gets its own new copy, and the other links keep the old contents;
a write that fails partway leaves the old file intact. Permissions carry
over (a script stays executable; on Windows a file's own access rules are
copied to the new copy), and a read-only file is refused.

So is the text encoding. Files that aren't UTF-8 — Windows-1250 or another
legacy code page, or UTF-16 with a byte-order mark (what PowerShell 5.1
writes by default) — are read, searched and edited in their own encoding
and written back in it, byte-order mark included; only the edited text
changes. A legacy encoding is recognised from the file's contents, so it is
a best guess, and `read_file` tells the model which one it used. A change
the encoding can't store (an emoji in a Windows-1250 file) is refused rather
than written as `?`, and a file that doesn't decode cleanly can be read but
not edited.

The tools run inside Loach, but what they read becomes part of the
conversation: with a cloud provider, those file contents are sent to it
like any other message.

**Project instructions.** If the folder has a `LOACHFILE.md` at its root,
its contents are added to the system prompt on every turn, right after the
note that tells the model where it is — the same idea as a `CLAUDE.md` or
`AGENTS.md`: the project's own notes on how to work in it (how to run the
tests, what not to touch, house style). It is read fresh each turn, so an
edit — yours, or one the model makes through `write_file` — takes effect on
the next send, and it goes through the same sandbox as everything else, so
a `LOACHFILE.md` that is a link out of the folder is ignored. The
"Working in" notice shows a `LOACHFILE.md` badge while one is present, with its first line in
the tooltip, and the context usage popover (§2.10) lists it on its own
row. Anything past 32 KB is cut with a note; local models follow short
instruction files far better, so keep it brief. A blank file counts as
none. The file goes in fenced between clear start and end markers, ahead
of your own instructions, and the model is told it's the project's text
rather than yours: it can't grant permissions, yours win when the two
conflict, and anything in it asking to send files or data elsewhere is to
be ignored unless you ask for that too — a folder you just cloned can say
anything, and the approval card on writes, moves and deletions remains
the backstop. A sample to start from is in
[`docs/LOACHFILE.md.sample`](LOACHFILE.md.sample).

Deliberately absent: a shell, a recursive delete, and any way to point the
tools at a folder other than through the native picker.

---

## 10. Search palette

Press **Cmd/Ctrl+K** (or click the title-bar search pill) to open a global
command palette:

- Cross-searches **chats**, **messages**, **spaces**, **snippets** and the
  **Library**.
- Empty query shows recent chats, spaces, snippets and Library items as
  suggestions.
- Arrow keys to move, Enter to commit, Esc to dismiss (or to clear a
  non-empty query first).
- Picking a chat opens it. Picking a Space opens its detail view. Picking
  a Snippet starts a fresh chat with the snippet's prompt primed. Picking
  a message opens its chat and jumps to that turn. Picking a Library item
  opens its preview where you are; picking a dataset opens its page in the
  Library.

This is the Library's only search (its page has no box of its own):
datasets match by name and description, items by title, the opening of
their text (about 280 characters) and a link's address — not by the whole
body; searching inside sources is what a chat does with them (§4.5). When
many kinds match, the slots are shared out between them so chat titles
can't push Library hits off the list.

**Message search** looks inside transcripts, not just titles. Hits carry a
`MESSAGE` badge and an excerpt that opens just before the match, and sort
below title matches — a chat whose *title* matches is the stronger signal, but transcript
hits keep a reserved block at the bottom so a common word can't squeeze them
out. It starts at two characters, is debounced, and returns up to 8 hits
(20 when the search is scoped to messages).

What it deliberately doesn't reach: archived chats (matching the title
search), system notices, imported turns hidden inside a collapsed card, and
matches that only occur inside an attachment or fetched-page body the bubble
doesn't display — jumping to any of those would scroll nowhere or highlight
nothing. Private Chat never touches the database, so it can't appear here.
Message-search case-insensitivity is ASCII-only, so a non-ASCII query
matches transcript text at its own case but not across cases (title
matching is fully case-folded).

**Scoping.** A dropdown beside the input narrows to one kind: *everywhere*
(the default), *chats*, *messages*, *spaces*, *snippets* or *library*. It
works by writing an `in:<scope>` token into the query itself — the token
*is* the scope, so you can type `in:messages borrow` or `in:library thesis`
by hand, or `notes in:spaces` with the token last, and the dropdown label
follows either way. Clearing the token from the text returns to
*everywhere*.

The palette is suppressed while onboarding, the lock screen or Private
Chat owns the window, and while another dialog (Settings, a confirmation)
is open.

---

## 11. Code canvas

Inline code blocks in assistant messages get an **Open** button (tooltip
"Open in canvas"). Clicking opens a right-side panel:

- Header reading *Code Canvas* (*Text canvas* for plain text, or the
  file's name when opened from an attachment), with a badge for the
  block's language.
- **Copy** to clipboard.
- **Export** — opens the native save dialog with a sensible default
  filename (extension picked from the language: `snippet.ts`, `snippet.py`,
  `Dockerfile`, etc.).
- **VS Code** (tooltip "Open in VS Code") — writes the snippet to a
  scratch file in Loach's cache folder and opens it in VS Code via the
  `code` CLI. If `code` isn't on your PATH, the button
  surfaces a short hint on how to add it rather than failing silently.
- Read-only body with line numbers and syntax highlighting via
  `highlight.js`. Highlighting is language-aware; unknown languages fall
  back to auto-detect.
- **Live updates** — when opened on a reply that's still streaming, the
  canvas keeps mirroring the latest code block as more tokens arrive.
- **Resizable** — drag the left edge to set the panel width; the choice
  is remembered.
- **HTML preview** — for HTML (an `html` code block, or an `.html` /
  `.htm` attachment) a **Code / Preview** switch renders the page, and
  HTML code blocks get a **Preview** button that opens the canvas straight
  on it. The page shows with its **scripts off**: markup and styles only,
  enforced by the preview's own security policy (inline scripts, event
  handlers and `javascript:` links are refused). **Run scripts** turns them
  on for that page — any other code block or edit starts off again — and
  then scripts and form handlers work; **Reload** starts the page over. On
  macOS and Linux the preview runs on Loach's own thread, so a script that
  never stops freezes the app until you quit it; the button's tooltip says
  so. On a reply that's still streaming, the preview appears once the code
  block is complete.

  The page runs in a sandbox, on an origin of its own: it can't reach
  Loach, your chats or your files, can't open windows or navigate away,
  and runs **offline** — scripts, stylesheets, images and fonts linked from
  the web don't load, so a page built on a CDN library (Tailwind,
  Chart.js, …) shows without it. `localStorage` and `sessionStorage`
  work but last only until the page reloads; cookies aren't available, and
  `alert()` does nothing. Frames inside the page (`<iframe>`, `<object>`,
  `<embed>`) are removed as they're added, and WebRTC isn't available (on
  Windows the engine itself also refuses it the UDP it would need).

The canvas and the parameters sidebar share the right slot — the canvas
wins when both would be open.

---

## 12. Appearance

In **Settings → Appearance**:

- **Theme** — *Solid* (calm flat background, azure accent) or *Aurora*
  (blurred mesh gradient under translucent glass panels, warm orange
  accent).
- **Color mode** — Light, System, Dark.
- **Font size** — Small, Normal, Large. Applied as a CSS scale to both
  rem-based and pixel-based text sizes.

Background style and color mode update instantly. On Windows and Linux the
window is borderless and the title bar draws its own window controls
(minimise / maximise / close); on macOS the window keeps the native
traffic-light buttons, overlaid on the title bar (and hidden in full
screen, where the bar takes the room back).

---

## 13. App lock (Security)

Optional credential gate that runs before any chat data hydrates, with
opt-in triggers (§13.4) that re-engage it mid-session. Configure in
**Settings → Security**.

- **PIN** (4, 6, or 8 digits), **Password** (at least 8 characters), or
  **both**.
- **Optional hint** stored alongside (plaintext — the user has to be able
  to read it after a failed unlock).
- **Argon2id** hashing in Rust; the lock blob lives in the OS credential
  store (Windows Credential Manager / Linux Secret Service / macOS
  Keychain), never on disk in plaintext, never in SQLite.
- **Marker file** — a non-secret copy of the lock's shape (whether one is
  set, its method, PIN length, and whether it has a hint) sits next to the
  database as `app_lock.json`, so the lock screen comes up at launch
  without reading the credential store (and without a keychain prompt).
  The credential store is read when you unlock; a read that fails or is
  refused keeps Loach locked.

### 13.1 Lock screen

Fills the window until the user authenticates. PIN field first when both
are required (fastest to type on a numeric pad). Wrong attempts clear the
PIN field (the password field is kept so the user can fix a typo).

### 13.2 Rate limiting

After 5 consecutive wrong credentials — at the lock screen or in any
re-authentication prompt (§13.3) — every credential check is refused for an
escalating window (30 s, 60 s, 2 min, … capped at 2 h). The count resets on
any successful check and when the lock is set or removed. It's saved next
to the database (`app_lock_attempts.json`), so restarting Loach doesn't
reset it.

### 13.3 Re-authentication for destructive actions

Changing or removing the lock and the destructive Data commands (import,
wipe, factory reset) require the user's *current* credentials even though
the app is unlocked, so a compromised renderer cannot silently disable the
gate or trigger a wipe.

### 13.4 Auto-lock

On its own the lock only gates *launch*: clear the lock screen once and you
stay unlocked until you quit. That covers a stolen laptop but not the threat
people actually have — walking away from an unlocked machine. Two opt-in
triggers close it, both in the **Auto-lock** card that appears in
**Settings → Security** once a lock is configured:

- **Lock after inactivity** — off, 1, 5, 15 or 30 minutes with no typing,
  clicking, scrolling, touch or mouse movement. A reply already streaming
  keeps running behind the lock screen. The countdown is a deadline checked periodically
  rather than one long timer, so a machine that sleeps through the interval
  is over the threshold the moment it wakes; the trade is that the lock can
  land up to 15 seconds late.
- **Lock when minimized** — locks as soon as the window is minimized or
  otherwise hidden. Keyed on visibility, not focus, so a native save / open
  dialog (export, import, attaching a file) doesn't lock you out mid-task.

**`Cmd/Ctrl + Shift + L`** (or `/lock`) locks immediately from anywhere in
the app, whether or not either trigger is on. On macOS, closing the window
— which hides Loach there rather than quitting it — always locks it too.
Re-locking never touches the backend — it flips the render gate, and the
credentials were never in the renderer to begin with.

Locking closes any open confirmation dialog and drops pending toasts (their
**Undo** included), and ends a Private Chat session, wiping it as closing it
would (§2.8). Unlocking doesn't re-run startup: the open chat and its
draft are where you left them.

---

## 14. Data management

**Settings → Data** is where backups, restores, and cleanups live.

A read-only **storage breakdown** sits above the controls, so "how big is
this?" is answered before you reach for a destructive one:

- **Database** — total bytes on disk (the SQLite file plus its write-ahead
  log and shared-memory file) and the path, itemised into chats (messages,
  their reasoning and tool calls included, with message and chat counts),
  attachments inlined into messages and
  snippets, Spaces (with source counts), the Library (its items and the
  search index built over them), and **Other** (snippets, snippet
  variables and saved fill-ins, global memories, MCP servers, settings, and
  each chat's title, instructions and parameters).
- **Local models** — how many Ollama models are installed and what they
  weigh, as reported by Ollama. Listed for context, not as something Loach
  can reclaim: they're stored by Ollama, outside the app-data folder above.

Below it sit the actions:

- **Export data** — produces a single JSON blob with every chat, message,
  folder, Space, source, memory, Library item and dataset (and which chats
  and Spaces use them), snippet, snippet variable, MCP server, and setting.
  The Library's search index is left out; Loach rebuilds it after a restore.
  MCP headers and environment variables are scrubbed, and so are
  secrets passed as arguments and an HTTP server URL's credentials and
  query values (§9.2); chats leave out their workspace folder
  (§9.4). The save dialog and the file write happen in Rust; the panel
  confirms the path it saved to. Exports are tagged `loach/v2`: Loach 1.5
  and older refuse them rather than restore them without the Library,
  while this version still restores the `loach/v1` backups those made.
- **Import data** — open a previously exported JSON. It **replaces**
  everything in the database — the Library and memories included; a backup
  from before the Library existed leaves it empty — shows a count
  of the chats, messages, Spaces, Library items and datasets, snippets,
  variables and MCP servers that came in, then reloads. The stored OpenAI
  key is kept, and so is the current OpenAI base URL while a key is stored,
  so the key never goes to a server a backup names. Stdio MCP servers
  arrive disabled (§9.2); a server name that breaks the naming rules is
  fixed up rather than failing the import. Requires
  current app-lock credentials when a lock is configured.
- **Archive all chats** — parks every live chat in the archive (§2.7).
- **Erase & Reset → Remove my data** — drops chats, folders, Spaces (with
  their sources and memories), the whole Library (texts, files, links and
  datasets), global memories, snippets, snippet variables and saved
  fill-ins, and MCP servers, but keeps app settings and the stored
  OpenAI key. Gated on the app-lock credentials, and on typing `YES`.
- **Erase & Reset → Factory reset** — the same wipe + clear all settings +
  remove the OpenAI key and the app lock from the credential store.
  Same `YES` confirmation. Loach then reloads straight into onboarding.
  Irreversible.

---

## 15. Onboarding

A six-step wizard runs on first launch (and after a factory reset). Each
step writes its choice straight into settings, so dismissing partway through
still leaves the app in a consistent state.

1. **Welcome** — intro card, plus *Restore from backup* for users arriving
   from another install.
2. **Provider** — pick Ollama or connect an OpenAI-compatible endpoint
   (the key is optional for local servers). This is the only
   required step; the X / Esc on it routes through a confirm dialog. It sits
   second so a model download has the rest of the wizard to make progress.
3. **Features** — defaults for Global memories, Temporal awareness,
   Thinking, and Low VRAM (recommends OFF / ON / ON / OFF). Committed on
   Skip as well as Continue.
4. **Tools** — Web fetch and the in-process utility tools, which before
   this screen existed were discover-by-accident in Settings. The
   utilities open on a **Recommended** preset — everything on except the
   four only a developer asks for (hash, UUID, base64, IP/CIDR) and
   Workspace files, which switches itself on when a chat gets a folder
   (§9.4) — and **All OFF / Recommended / All ON** buttons flip the set at
   once.
   Because the screen *shows* a selection, the write rules differ from
   Features: **Continue** commits the utilities exactly as displayed, while
   **Skip** writes only what was explicitly flipped, since skipping past is
   not consent to the recommended set. **Web fetch** is exempt from both
   the preset and the default — it starts off and is only ever written when
   touched, being the one switch on this screen that reaches the network.
   MCP gets a row with no switch: it's described here but configured in
   Settings.
5. **Prompt** — the global *Custom instructions* textarea.
6. **Final** — closes the wizard, lands the user in a fresh chat with the
   model dropdown auto-opened so they can pick a model immediately.

The wizard does not ask for a display name. `{{USER_NAME}}` still resolves
from Settings → General; it just isn't collected up front, because the value
only pays off for users who go on to write it into a custom instruction.

### 15.1 Choosing a model

When Ollama is running but has no models, the step reads the host's capacity
(`system_info`) and leads with a single recommendation — the largest catalog
entry (by its footprint on the GPU) that runs comfortably and fits on disk —
or the smallest download when nothing runs comfortably or nothing fits the
free disk space — instead of asking a newcomer to pick blind from a dozen
tags.

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

Adapters under 1 GB of dedicated memory — and any adapter that reports
unified memory on Windows, or whose amdgpu metrics mark it as an APU on
Linux — are ignored as integrated graphics, which carve out
system RAM and are already covered by the RAM path. Every probe
is best-effort: anything unreadable falls back to RAM, which stays correct for
CPU-only and integrated setups.

**A model's memory need is modeled, not equated with its download.** Each
catalog variant is a `SizedVariant` (`src/lib/modelChoice.ts`) carrying up to
three facts, because two architectures deliberately decouple the download from
the memory that matters — in opposite directions:

- `sizeGb`, the download. Billed to the disk check, and the bound for "runnable
  at all": when a model overflows the GPU its weights are mmapped from system
  RAM, so the download (not an inflated estimate) is what must fit there.
- `residentGb`, set only where an architecture keeps part of itself off the
  accelerator. Gemma's E-variants are the case: `gemma4:e2b` downloads 7.2 GB
  but holds ~2.5 GB on the card (per-layer embeddings stay in system RAM), so
  judging it by its download declared an edge-device model too big for the
  8 GB cards it targets. The figures are estimates — Ollama publishes no
  runtime memory numbers to validate them against.
- `moe`, for mixture-of-experts models. Every expert must be held, so the
  memory math is unchanged — but only a few billion parameters run per token,
  which changes what overflowing VRAM *means*: a dense 31B spilling to RAM
  crawls, while a 30B-A3B split across GPU and RAM is in the mode it was built
  for and stays quick. The classifier reports that as `moeSplit` and the badge
  reads "Runs well" instead of warning.

Runtime overhead on top of the resident weights (KV cache, compute buffers) is
a floor plus a small fraction, since it grows with layers and context rather
than weight bytes. The flat ×1.2 it replaces charged a 25 GB MoE model 5 GB of
phantom overhead — filing models that run well on a 32 GB / 8 GB-card machine
under "won't fit" — while barely taxing tiny ones. There is also no separate
VRAM reserve any more: the runner already keeps ~1 GB free when fitting layers
to the card, and reserving on top of that pushed every verdict a tier down.

Each variant carries a fit badge from the pure helpers in
`src/lib/modelChoice.ts`. Labels are plain verdicts a first-time user can
parse with no context — numbers and mechanics live in the tooltips:
**Runs well** (comfortable — and MoE splits, whose tooltip explains why
overflowing the GPU doesn't hurt them), **Runs OK** (fits with little
headroom), **Runs slowly** (a dense model exceeding VRAM but fitting RAM),
**Too big for this machine** (exceeds both; the ~N GB estimate lives in the
tooltip), or **Not enough disk space**, which also disables its Pull button.
Every evaluated row gets a badge — "good" is stated, not implied by absence —
coloured green ("Runs well", with a tick) and amber / yellow / red ("Runs OK"
/ "Runs slowly" / "Too big", each with an exclamation mark). The recommended
pick carries no special row badge: the recommendation card above the list is
its highlight, and the row shows the same honest verdict as any other. Rows within a family are ordered by resident
footprint so the badge column reads monotonically. The card names the
constraint it used — "Based on 8.0 GB VRAM · NVIDIA GeForce RTX 4060 · 412 GB
free on disk" rather than a RAM figure — since telling a GPU owner about their
RAM describes the
wrong bottleneck. Outside the Tauri shell `system_info` returns null and the
catalog renders unadorned.

Neither provider path pins a default model silently any more. Ollama shows a
picker of the models it found; the OpenAI path ranks the endpoint's catalog
so a chat model leads (`/v1/models` order routinely puts an embedding or
audio model first) and shows the pick in the same picker.

### 15.2 Downloads that outlive the wizard

Pulls started here keep running while the user finishes setup, so the
download is surfaced the whole way:

- A progress strip pinned to the bottom of every remaining wizard step, with
  a stop button per download (`admin_cancel` under the hood; Ollama keeps the
  layers it already fetched, so a re-pull resumes from them).
- The final screen swaps "You're all set" for "Setup complete / still
  downloading" rather than claiming readiness it doesn't have.
- `ModelDownloadBanner` above the composer in the chat itself.
- `sendUserMessage` refuses a send against a still-downloading model with
  "<tag> is still downloading (43%)". Without it Ollama returns 404 for the
  missing tag, which `providerErrors` renders as "endpoint or model not
  found. Check the model name and URL" — a wrong and unactionable first
  impression.

### 15.3 When Ollama isn't reachable

The step offers **Start Ollama** (the same `ollama_start` command the chat
header uses) before suggesting a download, since "installed but not running"
and "not installed" look identical from a failed probe — the error from a
failed start is what tells them apart. It also re-probes every 3 s in the
background, so a user who leaves to install Ollama returns to a green panel
instead of a stale warning they have to know to dismiss.

---

## 16. Custom instructions and template variables

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

### 16.1 Temporal awareness

When **Settings → Features → Temporal awareness** is on, Loach prepends a
short preamble with the current date, weekday and timezone (not the time)
to every system prompt if the prompt doesn't already use a
`{{CURRENT_*}}` placeholder. Authors who need the values inline — the time
included — drop the placeholders in directly; everyone else gets the auto
preamble. The Features tab also includes an expandable **"Template
variables"** cheat sheet listing the five `{{CURRENT_*}}` placeholders with
an example value (`{{USER_NAME}}` isn't in it).

---

## 17. Default model preferences

**Settings → General → Default model** controls which model new chats land
in. Three modes:

- **Use most recent** (default) — pick up wherever you left off.
- **Pin to provider** — **Use last Ollama model** or **Use last OpenAI
  model**.
- **A specific model** — pick one from the **Ollama models** / **OpenAI
  models** lists in the same menu to always start there.

**Preload on startup** (off by default, Ollama-only; under the Default model
picker): on app launch Loach sends an empty chat to the resolved default
model so it loads into VRAM ahead of your first real prompt. Pins VRAM even
if you open Loach just to read old chats, so the toggle is opt-in.

**Keep model loaded** (**Settings → Features**) — how long Ollama keeps a
model resident after a reply: **5 min** (shown by default), **30 min**,
**1 hour** or **Always**. Until you pick an option, Loach sends nothing and
the daemon's own `OLLAMA_KEEP_ALIVE` (or Ollama's 5-minute default)
applies. Once you pick one — 5 min included — it's sent as `keep_alive`
with every request, so it overrides `OLLAMA_KEEP_ALIVE`.

---

## 18. Updates

In-app updater for the Tauri-supported install formats:

- **Windows NSIS** — passive install of the downloaded signed
  `-setup.exe` after a click on **Install update**.
- **Linux AppImage** — same path; in-place replacement.
- **Linux `.deb` / `.rpm`** — the signed package is downloaded and handed
  to `dpkg -i` / `rpm -U` through a `pkexec` prompt (falling back to
  zenity / kdialog + `sudo`), so the package database stays consistent
  instead of a package install being silently overwritten. Package
  installs are recognised by a marker the bundler patches into the binary
  at build time (an AppImage by the variable its runtime sets), and the
  same check gates the panel — dev builds and `cargo run` report
  unsupported. There's no apt/yum repository, so `apt upgrade`
  still won't see new versions; updates are in-app only.
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

One historical gap: installs from **v1.2.3 or earlier** on `.deb` / `.rpm`
hide the Updates panel entirely, because that build's gate looked for an
AppImage environment variable. Those users need one manual download of a
newer build before in-app updates reach them.

**What's new** — every release includes a markdown notes file that
populates both the GitHub release body and the in-app **Updates** panel
when an upgrade is available.

Cryptographically signed with the Tauri updater's Ed25519 keys; signature
verification happens before the binary is replaced.

---

## 19. Storage and privacy posture

- **Everything except the OpenAI-compatible API key and the app-lock hash
  lives in a local SQLite database** under the user's app-data directory
  (apart from scratch files written for the canvas's **VS Code** button,
  a few layout preferences kept in the web view's local storage, and the
  app lock's non-secret marker and failed-attempt count — `app_lock.json`
  and `app_lock_attempts.json` next to the database, §13). Foreign
  keys are enforced in normal use; restoring a backup checks message roles,
  providers, MCP servers and setting keys, but skips foreign-key checks so
  older or partial backups still load — afterwards a chat pointing at a
  Space or folder the backup doesn't carry simply leaves it, and rows whose
  parent is missing are dropped.
- **OpenAI-compatible API key, app-lock hash** — OS credential store
  (Windows Credential Manager / Linux Secret Service / macOS Keychain via
  the `keyring` crate).
- **MCP credentials are not in the credential store.** A server's HTTP
  headers (an `Authorization` token, say) and a stdio server's environment
  variables are stored in the SQLite database as plain text, alongside the
  rest of its configuration. They are scrubbed from exports (§9.2), but
  anyone who can read the app-data directory can read them.
- **No telemetry** — Loach makes no outbound network requests beyond
  the providers the user configures (an embedding model for the Library
  included — §4.5), the optional URL fetches the user triggers (Library
  links included), the MCP servers the user wires up, and the in-app
  updater check against the GitHub releases endpoint.
- **CSP is locked down** — no remote scripts, no inline scripts, no eval.
  The Tauri global is disabled; the renderer talks to the backend only
  through registered commands. The one place inline scripts run is the
  canvas's HTML preview (§11), and only inside its sandboxed frame, which
  has its own policy: nothing it loads comes from outside the page, and it
  can't reach the network or Loach's commands.
- **File I/O is backend-owned** — every save dialog, the Data import
  dialog, the workspace folder picker (§9.4), and the actual read / write
  happen in Rust. The renderer can't pick a path itself (it only learns
  where a backup landed after the write), so a compromised UI cannot read
  or overwrite arbitrary files.
- **Running a program is backend-gated** — a stdio MCP server's command
  line is confirmed in a native OS dialog before it can start (§9.2), and
  every MCP tool call asks in the chat before it runs unless you opted that
  server or tool out. The in-chat approval cards guard against what the
  model asks for; they're answered in the app window, so the native dialog
  is the barrier against a compromised UI, not the cards.

---

## 20. Keyboard reference

Press `Cmd/Ctrl + /` to open an in-app cheat sheet of the nine app-wide
shortcuts (the first nine below), grouped into Navigation, Chat, Layout,
Security and Help; the composer and palette keys after them aren't in it.
The dialog reads the same table as the shortcut handler, so the keys listed
there are the keys the app actually listens for (`Cmd/Ctrl + K` is handled
by the search palette's own listener). The app-wide shortcuts are off
while onboarding, Private Chat or a dialog (the search palette included) is
open — except `Cmd/Ctrl + Shift + L` — and while the lock screen is up or
Loach is still checking at launch whether there is one. On keyboard
layouts without Latin letters (Cyrillic, Greek) a shortcut follows the
key's position, and `Cmd/Ctrl + /` works where `/` itself needs Shift
(German, French, Nordic layouts).

- `Cmd/Ctrl + K` — global search palette.
- `Cmd/Ctrl + N` — start a new chat.
- `Cmd/Ctrl + F` — find within the current chat transcript.
- `Cmd/Ctrl + U` — attach files to the current chat (opens the file picker).
- `Cmd/Ctrl + Shift + Backspace` (or `Delete`) — delete the current chat,
  after a confirmation — only while that chat is on screen, never from
  behind another page (a Space, a model, the Library).
- `Cmd/Ctrl + Shift + S` — show / hide the left sidebar.
- `Cmd/Ctrl + Shift + P` — show / hide the parameters panel (beside an open
  chat).
- `Cmd/Ctrl + Shift + L` — lock Loach now (when an app lock is configured;
  see §13.4).
- `Cmd/Ctrl + /` — open the keyboard-shortcuts cheat sheet.
- `/` (start of the composer) — open the slash-command palette.
- `#` (in the composer) — pick a Library source to attach (§4.3); `Tab`
  attaches the highlighted one, as does `Enter` after moving with the arrow
  keys.
- `Enter` — send the composer; in the command palette, complete the
  highlighted command (or run it once fully typed); in the search palette,
  open the highlighted result; in the in-chat finder, jump to the next match
  (`Shift + Enter` for the previous one).
- `Shift + Enter` — newline in the composer.
- `Tab` — in the command palette, complete the highlighted command.
- `Esc` — clear the search palette's query (a second press closes it),
  close the command palette or the in-chat finder, dismiss menus and
  dialogs, exit onboarding (with confirm on the provider step).
- Up / Down inside the search or command palette — move the active entry;
  in the in-chat finder, step through matches.

---

## 21. Platform support

- **Windows 10/11 x86_64** — NSIS installer, in-app updater.
- **Linux x86_64** — AppImage, `.deb`, and `.rpm`, all three with the
  in-app updater (§18). Built against **glibc 2.35**, so Ubuntu 22.04 and
  Debian 12 are the oldest supported distributions.
- **macOS 11+ Apple Silicon, with Safari 16.4 or later** — `.dmg` install
  plus a `.app` bundle, with in-app updater. Loach's window runs on the
  system's WebKit, which follows the installed Safari rather than the macOS
  version, and the Markdown renderer needs Safari 16.4's JavaScript — a Big
  Sur or Monterey Mac still on Safari 14 or 15 has to update Safari first.
  The build is **not Apple-notarized** (we don't subscribe to the Apple
  Developer Program), so first launch requires a one-time Gatekeeper
  bypass — see the README "Install on macOS" section. Intel Macs are not
  supported.

Loach runs as a single instance: launching it again (the Start menu, a
desktop file, a double click on the app) brings the running window
forward — out of the tray too — instead of starting a second copy over the
same database.

System requirements depend on the local model you pick (Loach itself is
small — a few hundred megabytes resident); Ollama's GPU requirements
apply when running local models.
