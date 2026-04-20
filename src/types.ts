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
