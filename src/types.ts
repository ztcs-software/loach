export type ProviderId = "ollama" | "openai";

/** Colour a chat can be marked with. The id is what's persisted — the actual
 *  swatch colours live in `src/lib/labels.ts`. */
export type ChatLabel =
  | "red"
  | "amber"
  | "green"
  | "blue"
  | "purple"
  | "pink";

export interface Session {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  system_prompt: string | null;
  params_json: string | null;
  space_id: string | null;
  pinned_at: number | null;
  /** Null → live chat; ms timestamp → archived at that time. */
  archived_at: number | null;
  /** Set when the chat was created via `forkSession`. Points at the source
   *  chat so the header can render a "Forked from …" badge with a link
   *  back. ON DELETE SET NULL on the FK clears this if the source is
   *  deleted — the fork survives, the badge just falls off. */
  forked_from_session_id: string | null;
  /** Colour marker, rendered as a dot at the very start of the chat row.
   *  Null → unlabelled, which is the default for every new chat. */
  label: ChatLabel | null;
  created_at: number;
  updated_at: number;
}

export interface Space {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Per-space default provider. Null = inherit the General Settings
   *  default. Set together with `default_model` to pin a chat to this
   *  pair on creation. */
  default_provider: ProviderId | null;
  default_model: string | null;
  /** JSON-encoded `GenerationParams` override for chats in this space.
   *  Null = inherit. Layered between model defaults and per-session
   *  overrides — see `chatStore::readSessionParams`. */
  default_params_json: string | null;
  /** Per-space toggle for the silent-auto-write memory extractor. Default
   *  on at space creation. When false, no new memories are auto-saved and
   *  the prompt builder skips the memory block — but existing rows stay
   *  in the DB so flipping it off doesn't strip context the user might
   *  still want to consult on the Memory tab. */
  memory_enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** One auto-saved (or hand-edited) fact scoped to a Space. The extractor
 *  proposes new rows after each assistant turn; the user can edit or delete
 *  any of them from the Memory tab. `source_session_id` / `source_message_id`
 *  point at the chat that produced the fact so the UI can link back to
 *  it; both are null for memories the user authored manually. */
export interface SpaceMemory {
  id: string;
  space_id: string;
  content: string;
  source_session_id: string | null;
  source_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SpaceFile {
  id: string;
  space_id: string;
  name: string;
  mime: string;
  kind: "text" | "image";
  data: string;
  size: number;
  position: number;
  created_at: number;
}

export interface SpaceContext {
  space: Space;
  files: SpaceFile[];
  memories: SpaceMemory[];
}

export interface Snippet {
  id: string;
  title: string;
  prompt: string;
  /** JSON-encoded Attachment[] — stored verbatim so large base64 payloads
   *  don't explode column counts and so the frontend owns the shape.
   *  Currently unused in the UI; kept as a column for forward compat. */
  attachments_json: string | null;
  /** Default provider pinned to this snippet (null → use current default). */
  provider: ProviderId | null;
  /** Default model pinned to this snippet (null → use current default). */
  model: string | null;
  created_at: number;
  updated_at: number;
}

/** User-defined static substitution. Resolved into `{{KEY}}` placeholders
 *  in a snippet body at expansion time. `key` is always uppercase
 *  (normalised at the command layer); reserved built-ins (`USER_NAME`,
 *  `CURRENT_*`) are rejected on save. */
export interface SnippetVariable {
  id: string;
  key: string;
  value: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/** Last value the user filled in for a prompt-on-use placeholder on a
 *  specific snippet. Loaded when the fill-blanks dialog opens so the
 *  inputs aren't blank on every run. */
export interface SnippetFillValue {
  snippet_id: string;
  key: string;
  value: string;
  updated_at: number;
}

export interface Attachment {
  kind: "image" | "text" | "file";
  name: string;
  mime: string;
  /** base64 (no data: prefix) for images and files, plain text for text files */
  data: string;
  /** Optional raw base64 of the original file, no `data:` prefix. Populated
   *  for PDF and DOCX attachments so the preview UI can save the original
   *  back to disk (PDF) or fall back to a "preview not available" placeholder
   *  with a working Save (DOCX). Absent on attachments created before this
   *  field existed — UI must treat it as optional. */
  bytes?: string;
  /** True when the source document was larger than the per-attachment
   *  extraction cap and only a leading slice survived in `data`. The model
   *  is told via an inline marker; the UI shows a "truncated" pill on the
   *  file chip so users know what reached the model isn't the full file. */
  truncated?: boolean;
}

export interface MessageMetrics {
  tokens: number;
  elapsed_ms: number;
  tokens_per_second: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | null;
  attachments_json: string | null;
  metrics_json: string | null;
  /** JSON-encoded `ToolCallRecord[]` — MCP tool calls + their results made
   *  during this assistant turn. Null for user / system messages and for
   *  pre-MCP assistant rows. */
  tool_calls_json: string | null;
  /** Non-null ms-timestamp = this message was rolled into the running
   *  auto-summary by the Compact button at that moment. The row keeps
   *  rendering in the transcript (so the user can scroll back) but
   *  `chatHistory()` skips it when building the next provider request,
   *  so the model only sees the summary block plus the trailing
   *  uncompacted turns. Null on every pre-existing row and on every
   *  freshly-appended message. */
  compacted_at: number | null;
  /** Non-null = this message came from the "Import context" dialog; the value
   *  is a group id shared by every row of one import, so the transcript can
   *  fold the batch into a single collapsible card and remove it as a unit.
   *  Null on normal user/assistant/system turns. */
  import_group: string | null;
  /** Only meaningful when `import_group` is set: `true` = the user chose to
   *  keep the imported batch folded out of the transcript. It still reaches
   *  the model like any other import — this flag governs display only. */
  import_hidden: boolean;
  created_at: number;
}

/** One MCP tool invocation surfaced in the transcript. The renderer pairs
 *  call + result and shows a single collapsible block per id. While the
 *  tool is still running, `result` is null and the UI shows a spinner. */
export interface ToolCallRecord {
  id: string;
  server_id: string;
  server_name: string;
  /** The qualified name the model picked (`<serverSlug>__<rawToolName>`). */
  tool: string;
  /** Arguments the model produced. Stored as a value so the UI can render
   *  with `JSON.stringify(…, null, 2)` for readability. */
  arguments: unknown;
  /** Plain text the MCP server returned. Null while the call is still
   *  in flight (the `tool_call` event fired but `tool_result` hasn't). */
  result: string | null;
  /** Mirrors MCP's `isError`. True for either a tool-reported failure
   *  (the tool ran but said "no") or a transport/dispatch error. */
  is_error: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId | string;
  family?: string | null;
  size?: number | null;
}

export interface GenerationParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_tokens?: number;
  num_ctx?: number;
  repeat_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Integer; omit / undefined = random each run. */
  seed?: number | null;
  /** Reasoning toggle for thinking-capable models. `true`/`false` is sent
   *  through to Ollama's `/api/chat` `think` parameter; `undefined` omits
   *  the field so the model uses its own default. The UI only surfaces this
   *  toggle for models whose `capabilities` include `"thinking"`. */
  think?: boolean;
  /** Ollama-only: how many model layers to offload to the GPU. `0` forces
   *  CPU-only inference, a positive integer offloads that many layers, and
   *  `undefined` lets Ollama auto-detect. Lets users dial offload down when
   *  the model OOMs the GPU. Ignored by OpenAI providers. */
  num_gpu?: number;
  /** Ollama-only: opt into low-VRAM mode. `true` shrinks batch sizes and
   *  the KV cache; `undefined` / `false` leaves Ollama's default (off).
   *  Pairs with `num_gpu` for memory-constrained setups. Ignored by OpenAI
   *  providers. */
  low_vram?: boolean;
}

export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  max_tokens: 4096,
  num_ctx: 8192,
  repeat_penalty: 1.1,
  frequency_penalty: 0,
  presence_penalty: 0,
  seed: null,
};

export interface ChatMessageIn {
  role: "user" | "assistant" | "system";
  content: string;
  images: string[]; // base64
}

export interface ChatRequest {
  stream_id: string;
  provider: ProviderId;
  model: string;
  base_url: string;
  system_prompt: string | null;
  messages: ChatMessageIn[];
  params: GenerationParams;
  /** Private Chat marker. When `true`, the backend skips MCP tool
   *  aggregation so the model can't autonomously forward prompt content
   *  to a user-configured MCP server. Omit (or pass `false`) for regular
   *  chats — defaults on the Rust side via `#[serde(default)]`. */
  private?: boolean;
}

export type StreamEvent =
  | { kind: "token"; delta: string }
  | { kind: "thinking"; delta: string }
  /** Stream ended naturally — provider emitted its EOF / `[DONE]` marker. */
  | { kind: "done" }
  /** Stream was cancelled mid-flight. Distinct from `done` so callers
   *  can avoid the "real completion" side-effects (memory extraction,
   *  unread dot) on an interrupted reply. Mirrors
   *  `src-tauri/src/stream.rs::StreamEvent::Cancelled`. */
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  | {
      kind: "metrics";
      tokens: number;
      elapsed_ms: number;
      tokens_per_second: number;
    }
  /** Model asked to invoke an MCP tool. Emitted BEFORE the dispatcher
   *  runs the tool — the UI uses this to render a "calling X…" block. */
  | {
      kind: "tool_call";
      id: string;
      server_id: string;
      server_name: string;
      tool: string;
      arguments: unknown;
    }
  /** Outcome of a tool call. `id` pairs with the matching `tool_call`. */
  | {
      kind: "tool_result";
      id: string;
      content: string;
      is_error: boolean;
      /** Files produced by the tool (today only the built-in `pdf` tool
       *  fills this). The chat store appends them to the assistant
       *  message's `attachments_json` so the existing PdfPreview /
       *  file-card renderers handle display. Optional with default `[]`
       *  so prior tool_result events deserialise unchanged. */
      attachments?: Attachment[];
    };

export type ThemeChoice = "light" | "dark" | "system";
export type BackgroundStyle = "gradient" | "solid";
export type FontSize = "small" | "normal" | "large";

/** How long Ollama keeps a model resident in VRAM after a request. Maps to
 *  the `keep_alive` field on `/api/chat`: a Go duration string, or `"-1"`
 *  (sent as the integer -1) to keep it loaded until explicitly unloaded.
 *  `"5m"` matches Ollama's own default — the value Loach effectively used
 *  before this setting existed. */
export type OllamaKeepAlive = "5m" | "30m" | "1h" | "-1";

export interface Settings {
  theme: ThemeChoice;
  background_style: BackgroundStyle;
  /** Global font-size scale. Applied as a class on `<html>` which the CSS
   *  in `globals.css` reads to scale both rem-based and absolute pixel
   *  text sizes via the `--font-scale` variable. */
  font_size: FontSize;
  ollama_base_url: string;
  openai_base_url: string;
  /** Free-text instructions injected as the system prompt of every new chat.
   *  Keyed `global_system_prompt` for backwards compat with the on-disk KV
   *  table; the UI now surfaces it as "Custom instructions". */
  global_system_prompt: string;
  /** Last-used provider+model. Always tracked so "Use most recent" can resolve
   *  to a concrete pair. Not surfaced directly in the UI. */
  default_provider: ProviderId;
  default_model: string;
  /** How `New chat` picks its initial model. Encoded as one of:
   *   - `"recent"`              — use the last (provider, model) pair (default)
   *   - `"provider:ollama"`     — same, but pinned to a single provider
   *   - `"provider:openai"`
   *   - `"model:<provider>:<model_id>"` — always start in this exact model
   *  Stored as a single string so it round-trips through the string-keyed KV
   *  settings table without bespoke serialisation. */
  default_model_choice: string;
  /** When true, the resolved default model is sent to Ollama with an empty
   *  chat at app startup so it loads into VRAM ahead of the user's first
   *  request. Only meaningful when the resolved default is an Ollama model;
   *  ignored otherwise. Off by default — preloading pins VRAM even if the
   *  user opens the app just to read past chats. */
  default_model_preload: boolean;
  /** Optional display name for the user. Substituted into system prompts via
   *  the `{{USER_NAME}}` template variable. Empty string = no preference. */
  user_name: string;
  /** When true, the current date / time / weekday / timezone are injected
   *  into the system prompt of every request. Compatible with Open WebUI
   *  temporal template variables (`{{CURRENT_DATE}}`, `{{CURRENT_TIME}}`,
   *  `{{CURRENT_WEEKDAY}}`, `{{CURRENT_DATETIME}}`, `{{CURRENT_TIMEZONE}}`). */
  temporal_awareness: boolean;
  /** When true, URLs detected in the user's prompt are fetched and their
   *  plain-text content is inlined into the outgoing message. Requires a
   *  network round-trip per URL — default is off so Loach stays offline-first
   *  unless the user opts in. */
  web_fetch_enabled: boolean;
  /** When true, a built-in `calculate` tool is exposed to the model
   *  alongside any MCP tools. The tool runs a real math evaluator
   *  (meval) in-process — no network, no DB. Off by default so the model
   *  catalogue stays minimal until the user opts in. Useful because
   *  local models are unreliable at multi-digit / multi-step arithmetic
   *  and otherwise tend to hallucinate answers. */
  calculate_tool_enabled: boolean;
  /** Per-tool toggles for the rest of the built-in tools. Each runs
   *  entirely in-process (no network, no DB writes) and is exposed to
   *  the model alongside MCP tools when on. All default to off so the
   *  model catalogue stays minimal until the user opts in — see
   *  `src-tauri/src/tools/builtin.rs` for the registry. */
  datetime_tool_enabled: boolean;
  count_tool_enabled: boolean;
  hash_tool_enabled: boolean;
  uuid_tool_enabled: boolean;
  base64_tool_enabled: boolean;
  json_tool_enabled: boolean;
  unit_convert_tool_enabled: boolean;
  diff_text_tool_enabled: boolean;
  sort_tool_enabled: boolean;
  ip_tool_enabled: boolean;
  /** Built-in `pdf` tool — `create` action generates PDFs from a
   *  structured spec (headings, paragraphs, lists, tables) and attaches
   *  them to the assistant message via the existing `PdfPreview`. v1 is
   *  ASCII-only (built-in Helvetica) and doesn't support image blocks
   *  or merging existing PDFs yet — `merge` returns a not-yet-supported
   *  error. */
  pdf_tool_enabled: boolean;
  /** Global override for Ollama's `low_vram` option. When `true`, every
   *  Ollama request is sent with `low_vram: true` regardless of per-chat
   *  params or per-model Modelfile defaults — handy on memory-constrained
   *  hardware where you'd otherwise have to remember to flip the per-chat
   *  toggle. Off by default. Ignored by OpenAI providers. */
  low_vram_global: boolean;
  /** How long Ollama keeps the resolved model resident in VRAM after each
   *  request (the `keep_alive` field). The default `"5m"` matches Ollama's
   *  own idle-unload timeout; longer values (or `"-1"` = until unloaded)
   *  stop the model being evicted between messages, so a reply after a pause
   *  skips the multi-second cold reload — at the cost of pinned VRAM.
   *  Ignored by OpenAI providers. */
  ollama_keep_alive: OllamaKeepAlive;
  /** Default value for the per-chat Thinking toggle. Applied as a baseline
   *  in `readSessionParams` so new chats (and chats that haven't touched
   *  the slider) inherit it. The per-chat Thinking switch in the parameter
   *  sidebar overrides it. Only meaningful for thinking-capable Ollama
   *  models — OpenAI providers ignore the field. */
  thinking_default: boolean;
  /** Default tone applied to every chat that hasn't picked one of its own.
   *  Stored as a string id matching `TONES` in `src/lib/tones.ts`; the empty
   *  / "default" id means "no style override". The per-chat override lives
   *  in uiStore (`toneIdBySession`) and falls back to this when unset. */
  default_tone_id: string;
  /** Flips to true after the user finishes (or dismisses) the first-launch
   *  onboarding flow. Default false; lives in the same KV settings table
   *  that `factory_reset` truncates, so a reset naturally re-fires the
   *  onboarding flow on next launch. */
  onboarding_completed: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  background_style: "gradient",
  font_size: "normal",
  ollama_base_url: "http://localhost:11434",
  openai_base_url: "https://api.openai.com/v1",
  global_system_prompt: "",
  default_provider: "ollama",
  default_model: "",
  default_model_choice: "recent",
  default_model_preload: false,
  user_name: "",
  temporal_awareness: true,
  web_fetch_enabled: false,
  calculate_tool_enabled: false,
  datetime_tool_enabled: false,
  count_tool_enabled: false,
  hash_tool_enabled: false,
  uuid_tool_enabled: false,
  base64_tool_enabled: false,
  json_tool_enabled: false,
  unit_convert_tool_enabled: false,
  diff_text_tool_enabled: false,
  sort_tool_enabled: false,
  ip_tool_enabled: false,
  pdf_tool_enabled: false,
  low_vram_global: false,
  ollama_keep_alive: "5m",
  thinking_default: true,
  default_tone_id: "default",
  onboarding_completed: false,
};

/** Shape returned by the Rust `fetch_url` command. Kept in sync with
 *  `src-tauri/src/tools/fetch_url.rs::FetchedPage`. */
export interface FetchedPage {
  url: string;
  final_url: string;
  title: string | null;
  text: string;
  content_type: string;
  bytes: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Model admin — Ollama
// ---------------------------------------------------------------------------

/** Response from `POST /api/show`. Every field is optional because older
 *  Ollama versions omit some of them and custom-created models may not have
 *  a template or system prompt baked in. */
export interface OllamaShowResponse {
  modelfile: string | null;
  parameters: string | null;
  template: string | null;
  system: string | null;
  license: string | null;
  /** Raw `details` sub-object — family, parameter_size, quantization_level,
   *  format, parent_model. Shape varies by model so we keep it loose. */
  details: Record<string, unknown> | null;
  /** `model_info` k/v map (e.g. `general.parameter_count`,
   *  `llama.context_length`). Shape varies — kept loose on purpose. */
  model_info: Record<string, unknown> | null;
  /** Capability tags from newer Ollama versions:
   *  `["completion", "tools", "thinking", "vision", …]`. Older Ollama
   *  builds omit the field entirely — null is the "we don't know" state,
   *  in which case features that gate on a capability fall back to off. */
  capabilities?: string[] | null;
}

/** Parameters that can be set in a `PARAMETER …` line of a Modelfile. Only
 *  the ones we expose in the UI — the full list has more obscure knobs but
 *  these are the knobs users actually reach for. */
export interface ModelfileParams {
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  min_p?: number | null;
  num_ctx?: number | null;
  num_predict?: number | null;
  num_batch?: number | null;
  num_gpu?: number | null;
  num_thread?: number | null;
  repeat_penalty?: number | null;
  repeat_last_n?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  tfs_z?: number | null;
  typical_p?: number | null;
  mirostat?: number | null;
  mirostat_eta?: number | null;
  mirostat_tau?: number | null;
  seed?: number | null;
  /** Free-form multi-value `PARAMETER stop …` entries. */
  stop?: string[];
}

/** Everything the Models editor controls. Maps 1:1 to the Modelfile we POST
 *  to `/api/create`. `from` is the base model the derived one is built on
 *  top of (`FROM …` directive). */
export interface ModelfileForm {
  /** Tag to save the derived model under, e.g. `my-llama:v1`. */
  name: string;
  /** Base model (`FROM …`). */
  from: string;
  system: string;
  template: string;
  params: ModelfileParams;
}

/** Event emitted on the `admin://{stream_id}` channel during long-running
 *  pull / create operations. Mirrors
 *  `src-tauri/src/stream.rs::AdminEvent`. */
export type AdminEvent =
  | {
      kind: "progress";
      status: string;
      digest?: string;
      total?: number;
      completed?: number;
    }
  | { kind: "done" }
  /** User cancelled the admin op mid-flight. The pull/create may have
   *  left partial state on the Ollama server side; the UI surfaces this
   *  as "Cancelled" rather than "Done" so the user doesn't think the
   *  partial work succeeded. */
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol)
// ---------------------------------------------------------------------------

/** An MCP server row as persisted in SQLite. Loach only speaks the
 *  Streamable-HTTP transport — one endpoint URL plus an optional map of
 *  request headers (typically auth). The `headers_json` blob arrives as a
 *  JSON string and is parsed lazily in `mcpStore`. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  /** JSON-encoded `Record<string, string>`. */
  headers_json: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Shape the Settings editor hands to `mcp_save` / `mcp_test`. Strings are
 *  trimmed and validated on the Rust side; `id` being undefined means
 *  "create new". */
export interface McpServerInput {
  id?: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpTool {
  name: string;
  description: string | null;
}

/** Result of `mcp_test` — a connectivity probe that does
 *  `initialize` + `tools/list`. On failure, `ok === false` and `error`
 *  carries a human-readable reason. */
export interface McpTestResult {
  ok: boolean;
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  tools: McpTool[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Data tab (export / import / wipe)
// ---------------------------------------------------------------------------

/** Per-table row-count breakdown returned from a successful `import_data_json`.
 *  Powers the post-import toast ("Imported 12 chats · 145 messages · …"). */
export interface ImportStats {
  sessions: number;
  messages: number;
  spaces: number;
  space_files: number;
  space_memories: number;
  snippets: number;
  snippet_variables: number;
  snippet_fill_values: number;
  mcp_servers: number;
  settings: number;
}
