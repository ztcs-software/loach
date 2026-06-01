import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AdminEvent,
  ChatRequest,
  FetchedPage,
  GenerationParams,
  ImportStats,
  McpServer,
  McpServerInput,
  McpTestResult,
  Message,
  ModelInfo,
  OllamaShowResponse,
  Session,
  Snippet,
  SnippetFillValue,
  SnippetVariable,
  Space,
  SpaceContext,
  SpaceFile,
  SpaceMemory,
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

/** Mint a unique-ish id for the no-backend fallback path. `Date.now()` alone
 *  collides on rapid double-clicks (two "New chat" presses in the same
 *  millisecond ship the same id and trip React's duplicate-key warning in the
 *  sidebar); appending a random suffix sidesteps that. Browser-preview only —
 *  production runs always hit the Tauri backend and get real UUIDs. */
function mockId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      id: mockId("mock"),
      title: args.title ?? "New chat",
      provider: args.provider as Session["provider"],
      model: args.model,
      system_prompt: args.system_prompt ?? null,
      params_json: null,
      space_id: args.space_id ?? null,
      pinned_at: null,
      archived_at: null,
      forked_from_session_id: null,
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("create_session", { args });
}

/** Branch a chat. When `up_to_message_id` is omitted, every message in the
 *  source is copied; when set, the fork stops after that message (inclusive).
 *  The returned `Session` has `forked_from_session_id` pointing at the
 *  source so the header can render the "Forked from …" badge. */
export function forkSession(args: {
  source_session_id: string;
  up_to_message_id?: string | null;
}): Promise<Session> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<Session>({
      id: mockId("mock-fork"),
      title: "Forked chat",
      provider: "ollama",
      model: "",
      system_prompt: null,
      params_json: null,
      space_id: null,
      pinned_at: null,
      archived_at: null,
      forked_from_session_id: args.source_session_id,
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("fork_session", { args });
}

export function renameSession(id: string, title: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("rename_session", { id, title });
}

export function pinSession(id: string, pinned: boolean): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("pin_session", { id, pinned });
}

export function archiveSession(id: string, archived: boolean): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("archive_session", { id, archived });
}

export function deleteSession(id: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_session", { id });
}

/** Persist a session's (provider, model) pair. Used by the chat header's
 *  model dropdown so a swap survives a reload. */
export function updateSessionModel(args: {
  id: string;
  provider: string;
  model: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_session_model", { args });
}

/** Persist the per-session "Custom instructions" textarea. Empty string is
 *  stored as empty (not null) so the textarea's exact contents round-trip. */
export function updateSessionSystemPrompt(args: {
  id: string;
  prompt: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_session_system_prompt", { args });
}

/** Persist the per-session generation-parameter override. Pass `null` to
 *  clear the override entirely (session falls back to model + app defaults). */
export function updateSessionParams(args: {
  id: string;
  params_json: string | null;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_session_params", { args });
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
      id: mockId("mock"),
      session_id: args.session_id,
      role: args.role,
      content: args.content,
      thinking: null,
      attachments_json: args.attachments_json ?? null,
      metrics_json: null,
      tool_calls_json: null,
      compacted_at: null,
      import_group: null,
      import_hidden: false,
      created_at: Date.now(),
    });
  }
  return invoke("append_message", { args });
}

/** Insert a batch of imported messages as one group (one collapsible card in
 *  the transcript, removable as a unit). `hidden` folds the card out of the
 *  transcript while the content still reaches the model. Returns the created
 *  rows so the caller can splice them straight into the in-memory list. */
export function importMessages(args: {
  session_id: string;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  hidden: boolean;
}): Promise<Message[]> {
  if (!isTauri) {
    const group = mockId("import");
    const base = Date.now();
    return notInTauri<Message[]>(
      args.messages.map((m, i) => ({
        id: mockId("mock"),
        session_id: args.session_id,
        role: m.role,
        content: m.content,
        thinking: null,
        attachments_json: null,
        metrics_json: null,
        tool_calls_json: null,
        compacted_at: null,
        import_group: group,
        import_hidden: args.hidden,
        created_at: base + i,
      })),
    );
  }
  return invoke("import_messages", { args });
}

/** Delete an imported batch as a unit, addressed by its group id. Scoped by
 *  `session_id` — the backend rejects calls whose rows don't belong to it. */
export function deleteImportGroup(
  sessionId: string,
  group: string,
): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_import_group", { sessionId, group });
}

export function updateMessage(args: {
  id: string;
  /** Required — Rust rejects updates whose row doesn't belong to this
   *  session. Callers always know which session the message belongs to
   *  (it's how they got the id) so this is a free defense-in-depth. */
  session_id: string;
  content: string;
  thinking?: string | null;
  metrics_json?: string | null;
  /** JSON-encoded `ToolCallRecord[]` — see `ToolCallRecord` in
   *  `types.ts`. Pass undefined / null on writes that don't touch tool
   *  calls; the backend `COALESCE`'s on the column so streaming flushes
   *  don't clobber tool-call records saved on a separate write. */
  tool_calls_json?: string | null;
  /** JSON-encoded `Attachment[]` produced by built-in tools during this
   *  assistant turn (today only `pdf`). Same COALESCE semantics as
   *  `tool_calls_json` — pass undefined / null on writes that don't
   *  touch attachments. */
  attachments_json?: string | null;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_message", { args });
}

/** Delete a single message. Scoped by `session_id` — the backend
 *  rejects calls whose row doesn't belong to the given session. */
export function deleteMessage(id: string, sessionId: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_message", { id, sessionId });
}

/** Delete every message in a session in one transactional call. Backs the
 *  `/clear` command — atomic and single round-trip, vs. a deleteMessage per
 *  message. */
export function clearSessionMessages(sessionId: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("clear_session_messages", { sessionId });
}

/** Mark a batch of messages as "rolled into the auto-summary": the rows
 *  stay in the DB and keep rendering in the transcript, but the chat
 *  history builder skips them so the model only consumes the summary
 *  block. Scoped by `session_id` — the backend rejects ids that don't
 *  belong to the given session. No-op in preview mode (no backend). */
export function markMessagesCompacted(args: {
  session_id: string;
  ids: string[];
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("mark_messages_compacted", {
    sessionId: args.session_id,
    ids: args.ids,
  });
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

// ------------ security (app lock) ------------

/**
 * Lock method picked by the user. Three combinations are supported; everything
 * else is intentionally absent (no biometrics yet, no recovery codes — keep
 * the surface narrow until the spec calls for more).
 */
export type LockMethod = "pin" | "password" | "both";

export interface LockStatus {
  configured: boolean;
  method: LockMethod | null;
  /** 4 / 6 / 8, or null when no PIN is configured. */
  pin_length: number | null;
  has_hint: boolean;
}

export interface SecuritySetupArgs {
  method: LockMethod;
  pin?: string;
  password?: string;
  /** Required when `method` involves a PIN. */
  pin_length?: 4 | 6 | 8;
  hint?: string;
  /** When a lock is already configured, the backend demands the user's
   *  CURRENT credentials before it will overwrite the keyring entry.
   *  Omit these on initial setup. */
  current_pin?: string;
  current_password?: string;
}

export function securityStatus(): Promise<LockStatus> {
  if (!isTauri)
    return notInTauri<LockStatus>({
      configured: false,
      method: null,
      pin_length: null,
      has_hint: false,
    });
  return invoke("security_status");
}

export function securitySetup(args: SecuritySetupArgs): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("security_setup", { args });
}

export function securityUnlock(args: {
  pin?: string;
  password?: string;
}): Promise<boolean> {
  // In non-Tauri (preview / mock mode) we don't enforce the lock — there's
  // no way to verify against a real keyring, and pretending to do so would
  // be a footgun for anyone running `vite preview`.
  if (!isTauri) return notInTauri(true);
  return invoke("security_unlock", { args });
}

export function securityGetHint(): Promise<string | null> {
  if (!isTauri) return notInTauri<string | null>(null);
  return invoke("security_get_hint");
}

/** Remove the configured app lock. The backend requires the user's CURRENT
 *  credentials so a compromised UI can't silently disable the lock. */
export function securityClear(args?: {
  pin?: string;
  password?: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("security_clear", { args: args ?? {} });
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

export function ollamaPreloadModel(baseUrl: string, model: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("ollama_preload_model", { baseUrl, model });
}

export function openaiListModels(baseUrl: string): Promise<ModelInfo[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("openai_list_models", { baseUrl });
}

// ------------ ollama model admin ------------

/** `POST /api/show` — returns the Modelfile, template, system prompt,
 *  parameters, license and model_info for a locally installed Ollama model.
 *  Used by the Models editor to prefill the form when deriving a new model. */
export function ollamaShowModel(
  baseUrl: string,
  name: string,
): Promise<OllamaShowResponse> {
  if (!isTauri)
    return notInTauri<OllamaShowResponse>({
      modelfile: null,
      parameters: null,
      template: null,
      system: null,
      license: null,
      details: null,
      model_info: null,
    });
  return invoke("ollama_show_model", { baseUrl, name });
}

/** `DELETE /api/delete` — remove a locally installed model. Irreversible. */
export function ollamaDeleteModel(baseUrl: string, name: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("ollama_delete_model", { baseUrl, name });
}

/** `POST /api/copy` — duplicate a model under a new tag. */
export function ollamaCopyModel(args: {
  base_url: string;
  source: string;
  destination: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("ollama_copy_model", { args });
}

/** `POST /api/pull` — download a model by tag from the registry. Emits
 *  `AdminEvent` progress frames on `admin://{stream_id}` while running.
 *  Caller provides the `stream_id` so it can subscribe before starting. */
export async function ollamaPullModel(
  args: { base_url: string; name: string; stream_id: string },
  onEvent: (ev: AdminEvent) => void,
): Promise<{ streamId: string; stop: () => Promise<void>; unlisten: UnlistenFn }> {
  if (!isTauri) {
    return {
      streamId: args.stream_id,
      stop: async () => {},
      unlisten: (() => undefined) as UnlistenFn,
    };
  }
  const channel = `admin://${args.stream_id}`;
  const unlisten = await listen<AdminEvent>(channel, (payload) =>
    onEvent(payload.payload),
  );
  const handle = await invoke<{ stream_id: string }>("ollama_pull_model", {
    args,
  });
  return {
    streamId: handle.stream_id,
    stop: async () => {
      await invoke("admin_cancel", { streamId: handle.stream_id });
    },
    unlisten,
  };
}

/** `POST /api/create` — build a new model from a Modelfile. Streams progress
 *  the same way `ollamaPullModel` does. */
export async function ollamaCreateModel(
  args: { base_url: string; name: string; modelfile: string; stream_id: string },
  onEvent: (ev: AdminEvent) => void,
): Promise<{ streamId: string; stop: () => Promise<void>; unlisten: UnlistenFn }> {
  if (!isTauri) {
    return {
      streamId: args.stream_id,
      stop: async () => {},
      unlisten: (() => undefined) as UnlistenFn,
    };
  }
  const channel = `admin://${args.stream_id}`;
  const unlisten = await listen<AdminEvent>(channel, (payload) =>
    onEvent(payload.payload),
  );
  const handle = await invoke<{ stream_id: string }>("ollama_create_model", {
    args,
  });
  return {
    streamId: handle.stream_id,
    stop: async () => {
      await invoke("admin_cancel", { streamId: handle.stream_id });
    },
    unlisten,
  };
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
      id: mockId("mock-space"),
      name: args.name,
      description: args.description ?? "",
      instructions: args.instructions ?? "",
      default_provider: null,
      default_model: null,
      default_params_json: null,
      memory_enabled: true,
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
  default_provider?: string | null;
  default_model?: string | null;
  default_params_json?: string | null;
  memory_enabled?: boolean | null;
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
      id: mockId("mock-sf"),
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
      space: {
        id: "",
        name: "",
        description: "",
        instructions: "",
        default_provider: null,
        default_model: null,
        default_params_json: null,
        memory_enabled: true,
        created_at: 0,
        updated_at: 0,
      },
      files: [],
      memories: [],
    });
  return invoke("get_space_context", { spaceId });
}

// ------------ space memories ------------

export function listSpaceMemories(spaceId: string): Promise<SpaceMemory[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_space_memories", { spaceId });
}

export function addSpaceMemory(args: {
  space_id: string;
  content: string;
  source_session_id?: string | null;
  source_message_id?: string | null;
}): Promise<SpaceMemory> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<SpaceMemory>({
      id: mockId("mock-mem"),
      space_id: args.space_id,
      content: args.content,
      source_session_id: args.source_session_id ?? null,
      source_message_id: args.source_message_id ?? null,
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("add_space_memory", { args });
}

export function updateSpaceMemory(args: {
  id: string;
  /** Required — Rust rejects updates whose row doesn't belong to this
   *  space. Same defense-in-depth shape as `updateMessage`. */
  space_id: string;
  content: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_space_memory", { args });
}

export function removeSpaceMemory(args: {
  id: string;
  space_id: string;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("remove_space_memory", { args });
}

// ------------ snippets ------------

export function listSnippets(): Promise<Snippet[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_snippets");
}

export function createSnippet(args: {
  title: string;
  prompt: string;
  attachments_json?: string | null;
  provider?: string | null;
  model?: string | null;
}): Promise<Snippet> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<Snippet>({
      id: mockId("mock-snip"),
      title: args.title,
      prompt: args.prompt,
      attachments_json: args.attachments_json ?? null,
      provider: (args.provider ?? null) as Snippet["provider"],
      model: args.model ?? null,
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("create_snippet", { args });
}

export function updateSnippet(args: {
  id: string;
  title: string;
  prompt: string;
  attachments_json?: string | null;
  provider?: string | null;
  model?: string | null;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_snippet", { args });
}

export function deleteSnippet(id: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_snippet", { id });
}

// ------------ snippet variables ------------

export function listSnippetVariables(): Promise<SnippetVariable[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_snippet_variables");
}

export function createSnippetVariable(args: {
  key: string;
  value: string;
  description?: string | null;
}): Promise<SnippetVariable> {
  if (!isTauri) {
    const now = Date.now();
    return notInTauri<SnippetVariable>({
      id: mockId("mock-var"),
      key: args.key.toUpperCase(),
      value: args.value,
      description: args.description ?? null,
      created_at: now,
      updated_at: now,
    });
  }
  return invoke("create_snippet_variable", { args });
}

export function updateSnippetVariable(args: {
  id: string;
  key: string;
  value: string;
  description?: string | null;
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("update_snippet_variable", { args });
}

export function deleteSnippetVariable(id: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("delete_snippet_variable", { id });
}

export function listSnippetFillValues(
  snippetId: string,
): Promise<SnippetFillValue[]> {
  if (!isTauri) return notInTauri([]);
  return invoke("list_snippet_fill_values", { snippetId });
}

export function upsertSnippetFillValues(args: {
  snippet_id: string;
  /** Flat tuples matching the Rust `Vec<(String, String)>`. */
  values: [string, string][];
}): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("upsert_snippet_fill_values", { args });
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

// ------------ tools ------------

/** Fetch a public URL via the Rust backend. SSRF-guarded, 15 s timeout, body
 *  capped at 5 MB, text output capped at ~12 000 chars. See
 *  `src-tauri/src/tools/fetch_url.rs` for the full story. Rejects with the
 *  underlying error string on failure (invalid URL, private IP, HTTP 4xx/5xx,
 *  timeout, network error). */
export function fetchUrl(url: string): Promise<FetchedPage> {
  if (!isTauri) {
    return Promise.reject(new Error("fetch_url requires the Tauri runtime"));
  }
  return invoke<FetchedPage>("fetch_url", { url });
}

// ------------ mcp servers ------------

/** List all user-configured MCP servers, sorted by name. */
export function mcpList(): Promise<McpServer[]> {
  if (!isTauri) return notInTauri([]);
  return invoke<McpServer[]>("mcp_list");
}

/** Upsert — create if `input.id` is undefined, update otherwise. Resolves
 *  to the row as it now stands in the DB. */
export function mcpSave(input: McpServerInput): Promise<McpServer> {
  if (!isTauri) {
    return Promise.reject(new Error("mcp_save requires the Tauri runtime"));
  }
  return invoke<McpServer>("mcp_save", { input });
}

export function mcpDelete(id: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke("mcp_delete", { id });
}

/** Probe the given config (handshake + tools/list) without persisting it.
 *  Always resolves — failures land inside `McpTestResult.error`. */
export function mcpTest(input: McpServerInput): Promise<McpTestResult> {
  if (!isTauri) {
    return Promise.resolve({
      ok: false,
      server_name: null,
      server_version: null,
      protocol_version: null,
      tools: [],
      error: "mcp_test requires the Tauri runtime",
    });
  }
  return invoke<McpTestResult>("mcp_test", { input });
}

// ------------ data (export / import / wipe) ------------

/** Returns a JSON string representing every table in the DB. Use
 *  `saveTextToFile` to put the result on disk through a backend-owned
 *  save dialog. */
export function exportDataJson(): Promise<string> {
  if (!isTauri) return Promise.reject(new Error("export requires the Tauri runtime"));
  return invoke<string>("export_data_json");
}

/** Native filter shape for {@link saveTextToFile}. */
export interface SaveDialogFilter {
  name: string;
  extensions: string[];
}

/** Open a native save dialog and write `content` to whichever path the
 *  user picks. The dialog and the write both happen in Rust, so the
 *  renderer cannot bypass the picker and write to an arbitrary path.
 *
 *  Resolves to the chosen path (string) on success, or `null` if the
 *  user cancelled the dialog. */
export function saveTextToFile(args: {
  content: string;
  default_path?: string;
  filters?: SaveDialogFilter[];
}): Promise<string | null> {
  if (!isTauri) {
    return Promise.reject(new Error("file save requires the Tauri runtime"));
  }
  return invoke<string | null>("save_text_to_file", {
    content: args.content,
    defaultPath: args.default_path,
    filters: args.filters,
  });
}

/** Binary sibling of `saveTextToFile`. `base64_data` is the raw image (or
 *  other binary) payload as base64 — no `data:` prefix. The backend
 *  decodes and writes the bytes to the user-chosen path. */
export function saveBinaryToFile(args: {
  base64_data: string;
  default_path?: string;
  filters?: SaveDialogFilter[];
}): Promise<string | null> {
  if (!isTauri) {
    return Promise.reject(new Error("file save requires the Tauri runtime"));
  }
  return invoke<string | null>("save_binary_to_file", {
    base64Data: args.base64_data,
    defaultPath: args.default_path,
    filters: args.filters,
  });
}

/** Write `code` to a temp file (named `filename`, used only for its basename +
 *  extension) and open it in VS Code via the `code` CLI. Rejects with a
 *  user-facing message when VS Code isn't on PATH or the launch fails. No-op
 *  outside Tauri. */
export function openInVscode(code: string, filename: string): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke<void>("open_in_vscode", { code, filename });
}

/** Optional app-lock credentials for destructive Tauri commands. */
export interface DestructiveAuth {
  pin?: string;
  password?: string;
}

/** Open a native open-file dialog, read the JSON, and apply it to the DB.
 *  Resolves to per-table row counts on success, or `null` if the user
 *  cancelled. Rejects on schema mismatch or read error.
 *
 *  When an app lock is configured the backend requires the current
 *  credentials — pass them via `auth`. The backend rejects the call (and
 *  never opens the dialog) if the gate doesn't pass. */
export function importDataWithDialog(
  auth?: DestructiveAuth,
): Promise<ImportStats | null> {
  if (!isTauri) return Promise.reject(new Error("import requires the Tauri runtime"));
  return invoke<ImportStats | null>("import_data_with_dialog", { auth });
}

/** Archive every non-archived session. Returns how many rows moved. */
export function archiveAllSessions(): Promise<number> {
  if (!isTauri) return notInTauri(0);
  return invoke<number>("archive_all_sessions");
}

/** Permanently delete every archived session (messages cascade). Returns
 *  the row count so the UI can confirm. Irreversible. */
export function deleteArchivedSessions(): Promise<number> {
  if (!isTauri) return notInTauri(0);
  return invoke<number>("delete_archived_sessions");
}

/** Drop all user-authored content (chats, spaces, snippets, MCP servers)
 *  while leaving app settings and the stored OpenAI key intact. Gated on
 *  the app-lock credentials when a lock is configured. */
export function wipeUserData(auth?: DestructiveAuth): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke<void>("wipe_user_data", { auth });
}

/** Factory reset — wipe_user_data + drop all settings + clear the OS
 *  credential-store OpenAI key. Irreversible. Gated on the app-lock
 *  credentials when a lock is configured. */
export function factoryReset(auth?: DestructiveAuth): Promise<void> {
  if (!isTauri) return notInTauri(undefined);
  return invoke<void>("factory_reset", { auth });
}

// ------------ updater ------------

/** Whether the running binary's bundle format supports in-app updates.
 *  Returns true on Windows (NSIS), and on Linux only when running inside
 *  an AppImage (`.deb` / `.rpm` installs are stuck with whatever the
 *  system package manager last installed). Wrapped here so callers don't
 *  have to construct a raw `invoke("updater_supported")` and stay
 *  consistent with the rest of the IPC layer. */
export function updaterSupported(): Promise<boolean> {
  if (!isTauri) return notInTauri(false);
  return invoke<boolean>("updater_supported");
}
