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

export interface Attachment {
  kind: "image" | "text";
  name: string;
  mime: string;
  /** base64 (no data: prefix) for images, plain text for text files */
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
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  num_ctx?: number;
}

export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 0.7,
  top_p: 0.95,
  max_tokens: 2048,
  frequency_penalty: 0,
  presence_penalty: 0,
  num_ctx: 4096,
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  background_style: "gradient",
  ollama_base_url: "http://localhost:11434",
  openai_base_url: "https://api.openai.com/v1",
  global_system_prompt: "",
  default_provider: "ollama",
  default_model: "",
};
