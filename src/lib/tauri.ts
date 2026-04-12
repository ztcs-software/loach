import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChatRequest,
  GenerationParams,
  Message,
  ModelInfo,
  Session,
  Space,
  SpaceContext,
  SpaceFile,
  StreamEvent,
} from "@/types";

/**
 * True when the JS bundle is hosted inside the Tauri WebView. False when
 * served from a plain browser (e.g. Vite preview, mockup mode), in which
 * case backend calls become safe no-ops so the UI still renders.
 */
export const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

function notInTauri<T>(fallback: T): Promise<T> {
  return Promise.resolve(fallback);
}

// ------------ sessions ------------

export function listSessions(): Promise<Session[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_sessions");
}

export function createSession(args: {
  title?: string;
  provider: string;
  model: string;
  system_prompt?: string | null;
  space_id?: string | null;
}): Promise<Session> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<Session>({
      id: `mock-${now}`,
      title: args.title ?? "New chat",
      provider: args.provider as Session["provider"],
      model: args.model,
      system_prompt: args.system_prompt ?? null,
      params_json: null,
      space_id: args.space_id ?? null,
      pinned_at: null,
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("create_session", { args });
}

export function renameSession(id: string, title: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("rename_session", { id, title });
}

export function pinSession(id: string, pinned: boolean): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("pin_session", { id, pinned });
}

export function deleteSession(id: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_session", { id });
}

export function exportSession(id: string, format: "json" | "md"): Promise<string> {
  if (!isTauri) return notInTauri("");
  return invoke("export_session", { id, format });
}

// ------------ messages ------------

export function listMessages(sessionId: string): Promise<Message[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_messages", { sessionId });
}

export function appendMessage(args: {
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments_json?: string | null;
}): Promise<Message> {
  if (!isTauri) {
    return notInTauri<Message>({
      id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      session_id: args.session_id,
      role: args.role,
      content: args.content,
      attachments_json: args.attachments_json ?? null,
      metrics_json: null,
      created_at: Date.now(),
    });
  }
  return invoke("append_message", { args });
}

export function updateMessage(args: {
  id: string;
  content: string;
  metrics_json?: string | null;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_message", { args });
}

// ------------ settings ------------

export function getSettings(): Promise<Record<string, string>> {
  if (!isTauri) return notInTauri({});
  return invoke("get_settings");
}

export function setSetting(key: string, value: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("set_setting", { key, value });
}

export function setOpenAIKey(key: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("set_openai_key", { key });
}

export function getOpenAIKeyStatus(): Promise<boolean> {
  if (!isTauri) return notInTauri(false);
  return invoke("get_openai_key_status");
}

export function clearOpenAIKey(): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("clear_openai_key");
}

// ------------ providers ------------

export function ollamaProbe(baseUrl: string): Promise<boolean> {
  if (!isTauri) return notInTauri(false);
  return invoke("ollama_probe", { baseUrl });
}

export function ollamaListModels(baseUrl: string): Promise<ModelInfo[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("ollama_list_models", { baseUrl });
}

export function ollamaUnloadModel(baseUrl: string, model: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("ollama_unload_model", { baseUrl, model });
}

export function openaiListModels(baseUrl: string): Promise<ModelInfo[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("openai_list_models", { baseUrl });
}

// ------------ spaces ------------

export function listSpaces(): Promise<Space[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_spaces");
}

export function getSpace(id: string): Promise<Space | null> {
  if (!isTauri) return notInTauri(null);
  return invoke("get_space", { id });
}

export function createSpace(args: {
  name: string;
  description?: string;
  instructions?: string;
}): Promise<Space> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<Space>({
      id: `mock-space-${now}`,
      name: args.name,
      description: args.description ?? "",
      instructions: args.instructions ?? "",
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("create_space", { args });
}

export function updateSpace(args: {
  id: string;
  name: string;
  description: string;
  instructions: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_space", { args });
}

export function deleteSpace(id: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_space", { id });
}

export function listSpaceFiles(spaceId: string): Promise<SpaceFile[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_space_files", { spaceId });
}

export function addSpaceFile(args: {
  space_id: string;
  name: string;
  mime: string;
  kind: string;
  data: string;
  size: number;
  position: number;
}): Promise<SpaceFile> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<SpaceFile>({
      id: `mock-sf-${now}`,
      space_id: args.space_id,
      name: args.name,
      mime: args.mime,
      kind: args.kind as "text" | "image",
      data: args.data,
      size: args.size,
      position: args.position,
      created_at: now,
    });
  }
  return invoke("add_space_file", { args });
}

export function removeSpaceFile(fileId: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("remove_space_file", { fileId });
}

export function getSpaceContext(spaceId: string): Promise<SpaceContext> {
  if (!isTauri)
    return notInTauri<SpaceContext>({
      space: { id: "", name: "", description: "", instructions: "", created_at: 0, updated_at: 0 },
      files: [],
    });
  return invoke("get_space_context", { spaceId });
}

// ------------ chat streaming ------------

export async function startChatStream(
  request: ChatRequest,
  onEvent: (ev: StreamEvent) => void,
): Promise<{ streamId: string; stop: () => Promise<void>; unlisten: UnlistenFn }> {
  if (!isTauri) {
    // Mock streaming so the UI is interactive in browser preview.
    let cancelled = false;
    const sample =
      "_(preview mode — Tauri backend not connected)_\n\nThis is a mocked response so you can see the chat UI render. In the native build, tokens stream in from your local Ollama or OpenAI-compatible endpoint.";
    const tokens = sample.split(/(\s+)/);
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      if (i < tokens.length) {
        onEvent({ kind: "token", delta: tokens[i++] });
        window.setTimeout(tick, 35);
      } else {
        onEvent({
          kind: "metrics",
          tokens: tokens.length,
          elapsed_ms: tokens.length * 35,
          tokens_per_second: 1000 / 35,
        });
        onEvent({ kind: "done" });
      }
    };
    window.setTimeout(tick, 80);
    return {
      streamId: request.stream_id,
      stop: async () => {
        cancelled = true;
      },
      unlisten: (() => undefined) as UnlistenFn,
    };
  }
  const channel = `chat://${request.stream_id}`;
  const unlisten = await listen<StreamEvent>(channel, (payload) => {
    onEvent(payload.payload);
  });
  const handle = await invoke<{ stream_id: string }>("chat_stream", { request });
  return {
    streamId: handle.stream_id,
    stop: async () => {
      await invoke("chat_cancel", { streamId: handle.stream_id });
    },
    unlisten,
  };
}

export function makeRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function mergeParams(
  base: GenerationParams,
  override?: GenerationParams | null,
): GenerationParams {
  return { ...base, ...(override ?? {}) };
}
