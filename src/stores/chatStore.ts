import { create } from "zustand";
import {
  appendMessage,
  archiveSession,
  createSession,
  deleteSession,
  getSpaceContext,
  listMessages,
  listSessions,
  makeRequestId,
  ollamaUnloadModel,
  pinSession,
  renameSession,
  startChatStream,
  updateMessage,
} from "@/lib/tauri";
import {
  imagesFromAttachments,
  inlineTextAttachments,
} from "@/lib/files";
import { applyTemporalAwareness } from "@/lib/temporal";
import {
  extractUrls,
  fetchAll,
  inlineFetchedPages,
} from "@/lib/webFetch";
import {
  DEFAULT_PARAMS,
  type Attachment,
  type ChatMessageIn,
  type GenerationParams,
  type Message,
  type MessageMetrics,
  type ProviderId,
  type Session,
} from "@/types";
import { useSettingsStore } from "./settingsStore";
import { useSpaceStore } from "./spaceStore";
import { useUIStore } from "./uiStore";
import { useModelsStore } from "./modelsStore";

interface ActiveStream {
  stop: () => Promise<void>;
  unlisten: () => void;
}

/** A chat generation unit: everything needed to start streaming for one
 *  prompt. Created up-front in `sendUserMessage` — the user message is
 *  persisted at that point, but the assistant placeholder is NOT (it's
 *  created lazily in `startTask` when the task actually starts). That way
 *  a waiting task that gets cancelled leaves no orphan empty assistant
 *  reply behind in the DB. */
interface QueueTask {
  id: string;
  sessionId: string;
  userMsgId: string;
  /** Pre-built ChatRequest payload (minus `stream_id`, which is fresh per
   *  start). Snapshotted at enqueue time so later state changes in the
   *  session can't contaminate the request. */
  request: {
    provider: ProviderId;
    model: string;
    base_url: string;
    system_prompt: string | null;
    messages: ChatMessageIn[];
    params: GenerationParams;
  };
}

interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  streamingByMessage: Record<string, MessageMetrics | null>;
  activeStream: ActiveStream | null;
  isStreaming: boolean;
  /** Which session the active stream belongs to (mirrors `runningTask`).
   *  Used by the composer to scope the "Stop generating" button to the chat
   *  actually being generated — switching to another chat must NOT show
   *  Stop there. */
  streamingSessionId: string | null;

  /** The single task currently streaming — or null if nothing is running.
   *  The app runs exactly one task at a time across ALL chats. */
  runningTask: QueueTask | null;

  /** Global FIFO of tasks waiting for the current runner to finish. Tasks
   *  from ANY chat pile up here; `finishRunning` pops the head (which may
   *  belong to any session). Cap: at most one task per session (running +
   *  waiting combined) — enforced in `sendUserMessage`. */
  queue: QueueTask[];

  /** Per-session "has an unseen assistant reply" flag. Set when an
   *  assistant message finishes streaming on a session the user is NOT
   *  actively viewing; cleared by `selectSession` when the user opens
   *  that chat. Drives the accent dot in the sidebar's chat list. */
  unread: Record<string, boolean>;

  hydrate: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  newSession: (opts?: {
    provider?: ProviderId;
    model?: string;
    /**
     * Which Space the session belongs to.
     * - `undefined` (default) → inherit the current `activeSpaceId` (used by
     *   SpaceView's "Start chat" and auto-create inside sendUserMessage).
     * - `null` → force a simple, space-less chat (used by the sidebar's
     *   "+ New chat" button regardless of where the user currently is).
     */
    spaceId?: string | null;
  }) => Promise<Session>;
  rename: (id: string, title: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setSessionModel: (id: string, provider: ProviderId, model: string) => Promise<void>;
  setSessionSystemPrompt: (id: string, prompt: string) => Promise<void>;
  /** Set per-session generation parameters. Pass `null` to remove the
   *  override entirely so the session falls back to (model defaults +
   *  app defaults). */
  setSessionParams: (id: string, params: GenerationParams | null) => Promise<void>;
  /** Append parsed messages onto the end of a session's transcript. Used by
   *  the "Import context" dialog — see `lib/importContext.ts` for the
   *  parser that produces the input shape. Each message is persisted via
   *  the same `append_message` command that real user/assistant turns use,
   *  so imported context shows up in exports too. */
  importMessages: (
    id: string,
    messages: { role: "user" | "assistant" | "system"; content: string }[],
  ) => Promise<void>;

  sendUserMessage: (content: string, attachments: Attachment[]) => Promise<void>;
  /** Interrupts whatever is happening for `sessionId`:
   *   - If that session is the currently running one → stops the stream,
   *     persists the partial reply, promotes the next waiter.
   *   - If that session is waiting in the queue → removes it. The persisted
   *     user message stays visible; no assistant placeholder existed yet. */
  cancelForSession: (sessionId: string) => Promise<void>;
  /** "Respond now" affordance on a waiting chat. Moves that chat's task to
   *  the head of the waiting queue, then cancels the current runner —
   *  which causes the teardown path to pick our task as the new head. */
  promoteSession: (sessionId: string) => Promise<void>;
}

/** Module-level re-entry guard for the auto-dispatcher. Set synchronously
 *  inside `promoteQueueHead` once a waiter is picked; cleared when the
 *  start attempt resolves. Prevents two `done`/cancel events in the same
 *  tick from both trying to promote the same head. */
let dispatching = false;

/** Buffers for the task currently being streamed. Held at module scope so
 *  `cancelForSession` (triggered by a button click, outside the stream
 *  closure) can still read the accumulated content and persist it before
 *  teardown. Cleared by `finishRunning`. */
let runningBuffers: {
  assistantMsgId: string;
  content: string;
  thinking: string;
  metrics: MessageMetrics | null;
} | null = null;

function parseOverrides(json: string | null): Partial<GenerationParams> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Partial<GenerationParams>;
  } catch {
    return {};
  }
}

/**
 * Resolve the effective parameters for a session, layering in this order:
 *
 *   1. App defaults (`DEFAULT_PARAMS`) — the universal fallback.
 *   2. Model defaults (Ollama only) — parsed from the Modelfile via
 *      `modelsStore.loadModelDefaults`. Only present if the cache was
 *      warmed; otherwise this layer is empty and we fall back to (1).
 *   3. Per-model user prefs (Ollama only) — currently just the Thinking
 *      toggle from ModelsView (`modelThinkPrefs`). Layered above the
 *      Modelfile so a user who turns thinking off for a model overrides
 *      Ollama's "thinking on by default" for capable models.
 *   4. Session overrides — whatever the user persisted by touching a slider
 *      (`params_json`). When `params_json` is `null` the session inherits
 *      from layers 1 – 3 only.
 *   5. Global app overrides — settings that win above every other layer,
 *      currently just the global Low-VRAM toggle from Settings → General.
 *      When the user pins it on we want it to apply to every chat with
 *      every model, even ones whose Modelfile sets `low_vram` differently.
 *
 * Read synchronously so the chat send path doesn't pay an async hop on
 * every message. Cache warming happens up-front in `newSession` /
 * `setSessionModel` so by the time the user hits Enter the merge has the
 * right data.
 */
function readSessionParams(session: Session | undefined): GenerationParams {
  if (!session) return { ...DEFAULT_PARAMS };
  const overrides = parseOverrides(session.params_json);
  const isOllama = session.provider === "ollama";
  const modelsState = isOllama ? useModelsStore.getState() : null;
  const modelDefaults = modelsState?.modelDefaults[session.model] ?? {};
  const thinkPref = modelsState?.modelThinkPrefs[session.model];
  const thinkLayer: Partial<GenerationParams> =
    thinkPref === undefined ? {} : { think: thinkPref };
  // Space-level defaults sit between model defaults and per-session
  // overrides — that way a per-chat slider edit still wins, but a fresh
  // chat in a space starts from the space's pinned settings rather than
  // the global DEFAULT_PARAMS.
  let spaceLayer: Partial<GenerationParams> = {};
  if (session.space_id) {
    const space = useSpaceStore
      .getState()
      .spaces.find((s) => s.id === session.space_id);
    if (space?.default_params_json) {
      try {
        spaceLayer = JSON.parse(space.default_params_json) as Partial<GenerationParams>;
      } catch {
        /* malformed JSON — ignore the layer */
      }
    }
  }
  const merged: GenerationParams = {
    ...DEFAULT_PARAMS,
    ...modelDefaults,
    ...thinkLayer,
    ...spaceLayer,
    ...overrides,
  };
  // Global Low-VRAM pin (Settings → General). Ollama-only — OpenAI ignores
  // the field, so we don't bother stamping it on those requests. Stays out
  // of `params_json` deliberately: a per-chat record of "user picked this"
  // shouldn't include settings the user never touched in the panel.
  if (isOllama && useSettingsStore.getState().low_vram_global) {
    merged.low_vram = true;
  }
  return merged;
}

function chatHistory(messages: Message[], userText: string, images: string[]): ChatMessageIn[] {
  const history: ChatMessageIn[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: m.content,
      images: [],
    }));
  history.push({ role: "user", content: userText, images });
  return history;
}

async function maybeAutoTitle(
  store: () => ChatState,
  setStore: (partial: Partial<ChatState>) => void,
  sessionId: string,
  firstUserContent: string,
) {
  const session = store().sessions.find((s) => s.id === sessionId);
  if (!session) return;
  if (session.title && session.title !== "New chat") return;
  const raw = firstUserContent.trim();
  const draft = raw.length > 28 ? raw.slice(0, 28).trimEnd() + "..." : raw;
  if (!draft) return;
  await renameSession(sessionId, draft);
  setStore({
    sessions: store().sessions.map((s) =>
      s.id === sessionId ? { ...s, title: draft } : s,
    ),
  });
}

// ---------------------------------------------------------------------------
// Task runner internals
// ---------------------------------------------------------------------------

type Getter = () => ChatState;
type Setter = (
  partial:
    | Partial<ChatState>
    | ((s: ChatState) => Partial<ChatState>),
) => void;

/** Called when a stream ends (done event, manual cancel, or startup error).
 *  Persists the partial assistant reply, tears down the active stream
 *  handle, clears running state, and kicks the next waiting task. Safe to
 *  call more than once — subsequent calls are no-ops because `runningTask`
 *  is null. */
function finishRunning(get: Getter, set: Setter) {
  const running = get().runningTask;
  const buf = runningBuffers;
  if (running && buf) {
    void updateMessage({
      id: buf.assistantMsgId,
      content: buf.content,
      thinking: buf.thinking || null,
      metrics_json: buf.metrics ? JSON.stringify(buf.metrics) : null,
    }).catch(() => {});
  }

  // If the chat that just finished streaming isn't the one the user is
  // currently viewing, mark it unread so the sidebar shows the accent dot.
  // We also require some content — a cancelled-on-user-message task that
  // produced no assistant output shouldn't pretend to be a "new reply".
  const activeId = get().activeSessionId;
  const finishedId = running?.sessionId;
  const producedContent = !!buf && buf.content.trim().length > 0;
  let unreadPatch: Record<string, boolean> | null = null;
  if (finishedId && producedContent && finishedId !== activeId) {
    unreadPatch = { ...get().unread, [finishedId]: true };
  }

  runningBuffers = null;

  const stream = get().activeStream;
  if (stream) {
    try {
      stream.unlisten();
    } catch {
      /* already unlistened — harmless */
    }
  }
  set({
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    ...(unreadPatch ? { unread: unreadPatch } : {}),
  });
  promoteQueueHead(get, set);
}

/** Promotes the head of the waiting queue to be the running task. Deferred
 *  via `queueMicrotask` so we don't try to start a new stream inside the
 *  same tick as the previous `done` event handler. */
function promoteQueueHead(get: Getter, set: Setter) {
  queueMicrotask(() => {
    if (dispatching) return;
    const q = get().queue;
    if (q.length === 0) return;
    if (get().runningTask) return;
    const [next, ...rest] = q;
    set({ queue: rest });
    dispatching = true;
    void startTask(next, get, set)
      .catch((err) => console.error("queued task start failed", err))
      .finally(() => {
        dispatching = false;
      });
  });
}

/** Starts a QueueTask: creates the assistant placeholder, opens the stream,
 *  wires event handlers. On any startup error, tears down and tries the
 *  next waiter so one broken task can't stall the whole queue. */
async function startTask(task: QueueTask, get: Getter, set: Setter) {
  const { sessionId } = task;

  // Create the assistant placeholder NOW (not at enqueue time). Keeping
  // the placeholder deferred means a waiting task that gets cancelled
  // leaves no orphan empty assistant row behind.
  let assistantMsg: Message;
  try {
    assistantMsg = await appendMessage({
      session_id: sessionId,
      role: "assistant",
      content: "",
    });
  } catch (e) {
    // Session might have been deleted while the task waited. Silently drop
    // and move on to the next.
    console.error("failed to create assistant placeholder", e);
    promoteQueueHead(get, set);
    return;
  }

  set((s) => ({
    messages: {
      ...s.messages,
      [sessionId]: [...(s.messages[sessionId] ?? []), assistantMsg],
    },
    streamingByMessage: { ...s.streamingByMessage, [assistantMsg.id]: null },
    isStreaming: true,
    streamingSessionId: sessionId,
    runningTask: task,
  }));

  runningBuffers = {
    assistantMsgId: assistantMsg.id,
    content: "",
    thinking: "",
    metrics: null,
  };

  const streamId = makeRequestId();

  try {
    const handle = await startChatStream(
      {
        stream_id: streamId,
        provider: task.request.provider,
        model: task.request.model,
        base_url: task.request.base_url,
        system_prompt: task.request.system_prompt,
        messages: task.request.messages,
        params: task.request.params,
      },
      (ev) => {
        const buf = runningBuffers;
        if (!buf) return; // cancelled between events
        if (ev.kind === "thinking") {
          buf.thinking += ev.delta;
          set((s) => ({
            messages: {
              ...s.messages,
              [sessionId]: (s.messages[sessionId] ?? []).map((m) =>
                m.id === assistantMsg.id ? { ...m, thinking: buf.thinking } : m,
              ),
            },
          }));
        } else if (ev.kind === "token") {
          buf.content += ev.delta;
          set((s) => ({
            messages: {
              ...s.messages,
              [sessionId]: (s.messages[sessionId] ?? []).map((m) =>
                m.id === assistantMsg.id ? { ...m, content: buf.content } : m,
              ),
            },
          }));
        } else if (ev.kind === "metrics") {
          buf.metrics = {
            tokens: ev.tokens,
            elapsed_ms: ev.elapsed_ms,
            tokens_per_second: ev.tokens_per_second,
          };
          set((s) => ({
            streamingByMessage: {
              ...s.streamingByMessage,
              [assistantMsg.id]: buf.metrics,
            },
          }));
        } else if (ev.kind === "error") {
          buf.content += `\n\n_⚠ ${ev.message}_`;
          set((s) => ({
            messages: {
              ...s.messages,
              [sessionId]: (s.messages[sessionId] ?? []).map((m) =>
                m.id === assistantMsg.id ? { ...m, content: buf.content } : m,
              ),
            },
          }));
        } else if (ev.kind === "done") {
          finishRunning(get, set);
        }
      },
    );
    set({ activeStream: { stop: handle.stop, unlisten: handle.unlisten } });
  } catch (e) {
    console.error("startChatStream failed", e);
    runningBuffers = null;
    set({
      activeStream: null,
      isStreaming: false,
      streamingSessionId: null,
      runningTask: null,
    });
    // Don't stall the queue if this one task failed to start.
    promoteQueueHead(get, set);
  }
}

/**
 * Resolve the user's "Default model" preference into a concrete
 * (provider, model) pair for a brand-new chat.
 *
 *   "recent"                 — last (provider, model) the user touched
 *   "provider:<id>"          — most recent session for that provider, or
 *                              empty model if there isn't one yet (the
 *                              chat header dropdown will catch this)
 *   "model:<provider>:<id>"  — pin to this exact model
 *
 * Anything unrecognised falls back to the recent pair so we never block a
 * "New chat" click on a malformed setting.
 */
function resolveDefaultModelChoice(
  choice: string,
  recentProvider: ProviderId,
  recentModel: string,
  sessions: Session[],
): { provider: ProviderId; model: string } {
  if (choice && choice.startsWith("model:")) {
    const rest = choice.slice("model:".length);
    const sep = rest.indexOf(":");
    if (sep > 0) {
      const p = rest.slice(0, sep);
      const m = rest.slice(sep + 1);
      if ((p === "ollama" || p === "openai") && m) {
        return { provider: p, model: m };
      }
    }
  }
  if (choice && choice.startsWith("provider:")) {
    const p = choice.slice("provider:".length);
    if (p === "ollama" || p === "openai") {
      // Pick the user's most recent model for that provider so a
      // provider-only pin still lands in something familiar. Sort defensively
      // — sessions in memory aren't guaranteed to be recency-ordered after
      // a model swap.
      const candidates = sessions
        .filter((s) => s.provider === p && s.model)
        .sort((a, b) => b.updated_at - a.updated_at);
      if (candidates.length > 0) {
        return { provider: p, model: candidates[0]!.model };
      }
      // No history yet — preserve the recent model only if it matches the
      // pinned provider, otherwise leave the model blank for the header to fill.
      return {
        provider: p,
        model: recentProvider === p ? recentModel : "",
      };
    }
  }
  return { provider: recentProvider, model: recentModel };
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  streamingByMessage: {},
  activeStream: null,
  isStreaming: false,
  streamingSessionId: null,
  runningTask: null,
  queue: [],
  unread: {},

  hydrate: async () => {
    try {
      const sessions = await listSessions();
      set({ sessions });

      // Remove all empty sessions (no messages) on startup, keep at most one.
      // Archived sessions are left alone even if empty — the user explicitly
      // moved them to the archive and shouldn't have them silently culled.
      const emptySessions: Session[] = [];
      for (const s of sessions) {
        const msgs = await listMessages(s.id);
        set((st) => ({ messages: { ...st.messages, [s.id]: msgs } }));
        if (msgs.length === 0 && !s.archived_at) emptySessions.push(s);
      }

      // Delete all empty sessions except the first (most recent)
      for (let i = 1; i < emptySessions.length; i++) {
        await deleteSession(emptySessions[i].id);
      }
      if (emptySessions.length > 1) {
        const remaining = sessions.filter(
          (s) => !emptySessions.slice(1).some((e) => e.id === s.id),
        );
        set({ sessions: remaining });
      }

      // Re-use the surviving empty session, or create a new one.
      if (emptySessions.length > 0) {
        await get().selectSession(emptySessions[0].id);
      } else {
        await get().newSession();
      }
    } catch (e) {
      console.error("chat hydrate failed", e);
    }
  },

  selectSession: async (id) => {
    // Opening a chat clears its unread flag — the user is now looking at
    // whatever the assistant produced. We do this regardless of whether
    // the chat had unread content; harmless when the entry was already
    // false / missing, and a single set is cheaper than a state read +
    // conditional set.
    set((s) => {
      const next = { ...s.unread };
      if (id && next[id]) delete next[id];
      return { activeSessionId: id, unread: next };
    });
    if (!id) return;
    if (!get().messages[id]) {
      const msgs = await listMessages(id);
      set((s) => ({ messages: { ...s.messages, [id]: msgs } }));
    }
  },

  newSession: async (opts) => {
    // Remove all existing empty sessions (no messages) before creating a new one.
    const { sessions, messages } = get();
    const emptyIds: string[] = [];
    for (const s of sessions) {
      if (s.archived_at) continue; // leave archived chats untouched
      const msgs = messages[s.id] ?? await listMessages(s.id);
      if (msgs.length === 0) emptyIds.push(s.id);
    }
    for (const id of emptyIds) {
      await deleteSession(id);
    }
    if (emptyIds.length > 0) {
      set((s) => ({
        sessions: s.sessions.filter((x) => !emptyIds.includes(x.id)),
        messages: Object.fromEntries(
          Object.entries(s.messages).filter(([k]) => !emptyIds.includes(k)),
        ),
      }));
    }

    // Wipe any leftover composer primer (e.g. a suggestion chip the user
    // clicked but never sent). Bump the seq so a currently-mounted ChatInput
    // also resets its local text state. Callers that want to seed the new
    // chat's composer (Snippets "Run") call primeComposer AFTER newSession,
    // so their primer still wins.
    useUIStore.setState((s) => ({
      composerDraft: "",
      composerAttachments: [],
      composerInsertSeq: s.composerInsertSeq + 1,
    }));

    const settings = useSettingsStore.getState();
    // `spaceId === undefined` → inherit activeSpaceId; `null` → force space-less.
    const spaceId =
      opts?.spaceId !== undefined
        ? opts.spaceId
        : useSpaceStore.getState().activeSpaceId;
    // If this chat lands in a space that pins its own default model, that
    // pin wins over the General Settings default. Both fields must be set —
    // a half-configured pin (provider but no model, or vice versa) falls
    // through to the global resolver so the chat doesn't land in a broken
    // (provider, "") state.
    const space = spaceId
      ? useSpaceStore.getState().spaces.find((s) => s.id === spaceId)
      : null;
    const fromSpace =
      space?.default_provider && space?.default_model
        ? { provider: space.default_provider, model: space.default_model }
        : null;
    const resolved =
      fromSpace ??
      resolveDefaultModelChoice(
        settings.default_model_choice,
        settings.default_provider,
        settings.default_model ?? "",
        get().sessions,
      );
    const p: ProviderId = opts?.provider ?? resolved.provider;
    const m = opts?.model ?? resolved.model;
    const session = await createSession({
      provider: p,
      model: m,
      system_prompt: settings.global_system_prompt || null,
      space_id: spaceId,
    });
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: session.id,
      messages: { ...s.messages, [session.id]: [] },
    }));
    // Warm the model-defaults cache for the session's model so the parameter
    // panel and the first send already see Modelfile values without having
    // to wait on the show_model round-trip. Fire-and-forget — failure here
    // just means we fall back to DEFAULT_PARAMS, same as before this feature.
    if (p === "ollama" && m) {
      void useModelsStore.getState().loadModelDefaults(m);
    }
    return session;
  },

  rename: async (id, title) => {
    await renameSession(id, title);
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    }));
  },

  pin: async (id, pinned) => {
    await pinSession(id, pinned);
    const pinned_at = pinned ? Date.now() : null;
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, pinned_at } : x,
      ),
    }));
  },

  archive: async (id, archived) => {
    await archiveSession(id, archived);
    // Archiving is effectively "park this chat" — kill any in-flight or
    // queued work for it so we don't keep streaming into a hidden chat.
    if (archived) {
      await get().cancelForSession(id);
    }
    const archived_at = archived ? Date.now() : null;
    set((s) => {
      const sessions = s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              archived_at,
              // Archiving also clears the pinned flag on the backend; mirror
              // that here so the UI doesn't briefly show a stale pin icon.
              pinned_at: archived ? null : x.pinned_at,
            }
          : x,
      );
      // If we just archived the currently active session, drop selection so
      // the main view doesn't keep rendering a chat that's no longer in the
      // normal list.
      const active =
        archived && s.activeSessionId === id ? null : s.activeSessionId;
      return { sessions, activeSessionId: active };
    });
  },

  remove: async (id) => {
    // Cancel any in-flight / queued task first so teardown persists into a
    // session that still exists in the DB.
    await get().cancelForSession(id);
    await deleteSession(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const messages = { ...s.messages };
      delete messages[id];
      const queue = s.queue.filter((t) => t.sessionId !== id);
      const active =
        s.activeSessionId === id ? sessions[0]?.id ?? null : s.activeSessionId;
      return { sessions, messages, queue, activeSessionId: active };
    });
  },

  setSessionModel: async (id, provider, model) => {
    const prev = get().sessions.find((x) => x.id === id);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, provider, model } : x,
      ),
    }));

    // Remember the last-used provider/model so future "New chat" sessions
    // default to it.
    useSettingsStore
      .getState()
      .setProviderDefault(provider, model)
      .catch(() => {});

    // Unload the previous Ollama model from VRAM to free resources.
    if (prev && prev.provider === "ollama" && prev.model && prev.model !== model) {
      const baseUrl = useSettingsStore.getState().ollama_base_url;
      ollamaUnloadModel(baseUrl, prev.model).catch(() => {});
    }
    // Warm the new model's defaults so the parameter panel snaps to its
    // values once the user opens it.
    if (provider === "ollama" && model) {
      void useModelsStore.getState().loadModelDefaults(model);
    }
  },

  setSessionSystemPrompt: async (id, prompt) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, system_prompt: prompt } : x,
      ),
    }));
  },

  setSessionParams: async (id, params) => {
    const next = params === null ? null : JSON.stringify(params);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, params_json: next } : x,
      ),
    }));
  },

  importMessages: async (id, parsed) => {
    if (parsed.length === 0) return;
    // Persist each message in order so timestamps line up monotonically
    // (the backend stamps `created_at = now()` on insert). We append to the
    // local cache only after the round-trip resolves so a backend failure
    // doesn't leave ghost messages in the UI.
    const created: Message[] = [];
    for (const p of parsed) {
      const m = await appendMessage({
        session_id: id,
        role: p.role,
        content: p.content,
      });
      created.push(m);
    }
    set((s) => ({
      messages: {
        ...s.messages,
        [id]: [...(s.messages[id] ?? []), ...created],
      },
    }));
  },

  sendUserMessage: async (rawContent, attachments) => {
    // If viewing a space, exit the space view and create a session in that space
    const spaceStore = useSpaceStore.getState();
    const viewingSpaceId = spaceStore.viewingSpaceId;
    if (viewingSpaceId) {
      // Clear view but keep activeSpaceId so newSession picks it up.
      // Also flip the sidebar back to "chats" — otherwise the main view
      // falls through to the Spaces library tiles (App.tsx routing) instead
      // of the new chat we're about to stream into.
      useSpaceStore.setState({ viewingSpaceId: null });
      if (useUIStore.getState().sidebarTab !== "chats") {
        useUIStore.getState().setSidebarTab("chats");
      }
    }

    const state = get();
    let sessionId = state.activeSessionId;
    // If we came from a space view, or have no session, create one
    if (!sessionId || (viewingSpaceId && state.sessions.find(s => s.id === sessionId)?.space_id !== viewingSpaceId)) {
      const created = await get().newSession();
      sessionId = created.id;
    }
    const session = get().sessions.find((s) => s.id === sessionId)!;
    if (!session.model) {
      throw new Error("No model selected. Pick one from the model dropdown.");
    }

    // Hard cap: at most one in-flight task per chat. If this session is
    // already the runner or already has a waiter, drop this submit. The UI
    // disables the send button in this state too — belt-and-suspenders.
    const snap = get();
    const alreadyBusy =
      snap.runningTask?.sessionId === sessionId ||
      snap.queue.some((t) => t.sessionId === sessionId);
    if (alreadyBusy) return;

    let inlinedContent = inlineTextAttachments(rawContent, attachments);
    const images = imagesFromAttachments(attachments);
    const attachmentsJson = JSON.stringify(
      attachments.map((a) => ({
        kind: a.kind,
        name: a.name,
        mime: a.mime,
        data: a.data,
      })),
    );

    // Optional web-fetch step: pull plain-text bodies for any http(s) URLs in
    // the user's raw prompt and append them as fenced blocks so the model has
    // the page content as prompt context. Silent on failure — a dead link
    // should never block the send. Off by default; opt-in in Settings.
    {
      const s = useSettingsStore.getState();
      if (s.web_fetch_enabled) {
        const urls = extractUrls(rawContent);
        if (urls.length > 0) {
          try {
            const outcomes = await fetchAll(urls);
            inlinedContent = inlineFetchedPages(inlinedContent, outcomes);
          } catch (e) {
            // fetchAll itself never throws, but be defensive — a thrown
            // exception here would eat the whole submit, and we'd rather
            // send the prompt without the fetched context than not at all.
            console.warn("web fetch step failed", e);
          }
        }
      }
    }

    // 1. Persist user message.
    const userMsg = await appendMessage({
      session_id: sessionId,
      role: "user",
      content: inlinedContent,
      attachments_json: attachmentsJson,
    });
    set((s) => ({
      messages: {
        ...s.messages,
        [sessionId!]: [...(s.messages[sessionId!] ?? []), userMsg],
      },
    }));

    // Auto-title from first user message.
    await maybeAutoTitle(get, (p) => set(p), sessionId, rawContent);

    // 2. Build the ChatRequest snapshot NOW, even if this task is going to
    //    wait. Snapshotting at submit time freezes the prompt/history the
    //    model will see — later edits to other messages in the session
    //    can't retroactively change a queued request.
    const settings = useSettingsStore.getState();
    const baseUrl =
      session.provider === "ollama"
        ? settings.ollama_base_url
        : settings.openai_base_url;
    const params = readSessionParams(session);
    const history = get().messages[sessionId] ?? [];
    // Drop the just-inserted user message from the ambient history; we'll
    // re-add it as the trailing chat message so `images` is attached.
    const trimmed = history.filter((m) => m.id !== userMsg.id);
    const chatMessages = chatHistory(trimmed, inlinedContent, images);

    // Resolve system prompt. When the chat is in a space:
    //  - Space instructions OVERRIDE the global / per-session prompt entirely
    //    (the user opted into space-level guidance, so we don't want a stale
    //    global prompt leaking through underneath).
    //  - Reference files are additive — they ride along regardless and get
    //    prepended to whichever prompt won, so the model has the file
    //    context whether or not the space pinned its own instructions.
    const fallbackPrompt =
      session.system_prompt && session.system_prompt.length > 0
        ? session.system_prompt
        : settings.global_system_prompt || "";

    let effectiveSystemPrompt: string | null = fallbackPrompt || null;
    if (session.space_id) {
      try {
        const ctx = await getSpaceContext(session.space_id);
        const spaceInstructions = ctx.space.instructions.trim();
        let filesBlock = "";
        const textFiles = ctx.files.filter((f) => f.kind === "text");
        if (textFiles.length > 0) {
          filesBlock = "--- Space reference files ---\n";
          for (const f of textFiles) {
            filesBlock += `\nFile: \`${f.name}\`\n\`\`\`\n${f.data}\n\`\`\`\n`;
          }
        }
        const base = spaceInstructions || fallbackPrompt;
        const parts: string[] = [];
        if (base) parts.push(base);
        if (filesBlock) parts.push(filesBlock);
        effectiveSystemPrompt = parts.length ? parts.join("\n\n") : null;
      } catch (e) {
        console.warn("Failed to load space context", e);
      }
    }

    // {{USER_NAME}} → the name from General settings (empty string if the
    // user hasn't set one). Done before temporal substitution so the temporal
    // pass doesn't have to know about it.
    if (effectiveSystemPrompt) {
      effectiveSystemPrompt = effectiveSystemPrompt.replace(
        /\{\{\s*USER_NAME\s*\}\}/g,
        settings.user_name ?? "",
      );
    }

    // Temporal awareness — always substitute {{CURRENT_*}} placeholders, and
    // (when enabled) prepend a short "Current date/time" preamble so the
    // model can answer "what day is it today?" without hallucinating.
    effectiveSystemPrompt = applyTemporalAwareness(
      effectiveSystemPrompt,
      settings.temporal_awareness,
    );

    const task: QueueTask = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      userMsgId: userMsg.id,
      request: {
        provider: session.provider,
        model: session.model,
        base_url: baseUrl,
        system_prompt: effectiveSystemPrompt,
        messages: chatMessages,
        params,
      },
    };

    // 3. Dispatch. If nothing is running globally, start immediately.
    //    Otherwise park in the waiting queue and let the runner pick us
    //    up when the current task ends.
    if (!get().runningTask) {
      await startTask(task, get, set);
    } else {
      set((s) => ({ queue: [...s.queue, task] }));
    }
  },

  cancelForSession: async (sessionId) => {
    const state = get();
    const running = state.runningTask;

    // Case A: this session is the currently running one. Stop the stream
    // (unlisten FIRST so late tokens can't still mutate state), persist
    // the partial, then let `finishRunning` promote the next waiter.
    if (running && running.sessionId === sessionId) {
      const stream = state.activeStream;
      if (stream) {
        try {
          stream.unlisten();
        } catch {
          /* ignore */
        }
        set({ activeStream: null });
        try {
          await stream.stop();
        } catch (e) {
          console.error("stream stop failed", e);
        }
      }
      finishRunning(get, set);
      return;
    }

    // Case B: this session is waiting in the queue. Just evict it. The
    // persisted user message stays — no assistant placeholder was ever
    // created for this task, so there's nothing else to clean up.
    const task = state.queue.find((t) => t.sessionId === sessionId);
    if (!task) return;
    set((s) => ({ queue: s.queue.filter((t) => t.id !== task.id) }));
  },

  promoteSession: async (sessionId) => {
    const state = get();

    // Nothing running → treat promote like a direct start.
    if (!state.runningTask) {
      const task = state.queue.find((t) => t.sessionId === sessionId);
      if (!task) return;
      set((s) => ({ queue: s.queue.filter((t) => t.id !== task.id) }));
      await startTask(task, get, set);
      return;
    }

    // Already running this session → no-op.
    if (state.runningTask.sessionId === sessionId) return;

    // Move the target task to queue[0], then cancel the current runner.
    // `finishRunning` inside that cancel path promotes the (now-first)
    // task of the queue, which is ours.
    const task = state.queue.find((t) => t.sessionId === sessionId);
    if (!task) return;
    const others = state.queue.filter((t) => t.id !== task.id);
    set({ queue: [task, ...others] });

    const stream = state.activeStream;
    if (stream) {
      try {
        stream.unlisten();
      } catch {
        /* ignore */
      }
      set({ activeStream: null });
      try {
        await stream.stop();
      } catch (e) {
        console.error("stream stop failed", e);
      }
    }
    finishRunning(get, set);
  },
}));
