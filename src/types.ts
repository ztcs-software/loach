export type ProviderId = "ollama" | "openai";

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
  created_at: number;
  updated_at: number;
}

export interface Space {
  id: string;
  name: string;
  description: string;
  instructions: string;
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

export interface Attachment {
  kind: "image" | "text" | "file";
  name: string;
  mime: string;
  /** base64 (no data: prefix) for images and files, plain text for text files */
  data: string;
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
  created_at: number;
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
}

export type StreamEvent =
  | { kind: "token"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | {
      kind: "metrics";
      tokens: number;
      elapsed_ms: number;
      tokens_per_second: number;
    };

export type ThemeChoice = "light" | "dark" | "system";
export type BackgroundStyle = "gradient" | "solid";

export interface Settings {
  theme: ThemeChoice;
  background_style: BackgroundStyle;
  ollama_base_url: string;
  openai_base_url: string;
  global_system_prompt: string;
  default_provider: ProviderId;
  default_model: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  background_style: "gradient",
  ollama_base_url: "http://localhost:11434",
  openai_base_url: "https://api.openai.com/v1",
  global_system_prompt: "",
  default_provider: "ollama",
  default_model: "",
  temporal_awareness: true,
  web_fetch_enabled: false,
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
  snippets: number;
  mcp_servers: number;
  settings: number;
}
