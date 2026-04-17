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
  setSessionParams: (id: string, params: GenerationParams) => Promise<void>;

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

function parseParams(json: string | null): GenerationParams {
  if (!json) return { ...DEFAULT_PARAMS };
  try {
    return { ...DEFAULT_PARAMS, ...JSON.parse(json) };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

function readSessionParams(session: Session | undefined): GenerationParams {
  if (!session) return { ...DEFAULT_PARAMS };
  return parseParams(session.params_json);
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
    set({ activeSessionId: id });
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
    const p: ProviderId = opts?.provider ?? settings.default_provider;
    const m = opts?.model ?? settings.default_model ?? "";
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
  },

  setSessionSystemPrompt: async (id, prompt) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, system_prompt: prompt } : x,
      ),
    }));
  },

  setSessionParams: async (id, params) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, params_json: JSON.stringify(params) } : x,
      ),
    }));
  },

  sendUserMessage: async (rawContent, attachments) => {
    // If viewing a space, exit the space view and create a session in that space
    const spaceStore = useSpaceStore.getState();
    const viewingSpaceId = spaceStore.viewingSpaceId;
    if (viewingSpaceId) {
      // Clear view but keep activeSpaceId so newSession picks it up
      useSpaceStore.setState({ viewingSpaceId: null });
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

    const inlinedContent = inlineTextAttachments(rawContent, attachments);
    const images = imagesFromAttachments(attachments);
    const attachmentsJson = JSON.stringify(
      attachments.map((a) => ({
        kind: a.kind,
        name: a.name,
        mime: a.mime,
        data: a.data,
      })),
    );

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

    // Resolve system prompt, injecting space context if applicable.
    let effectiveSystemPrompt =
      session.system_prompt && session.system_prompt.length > 0
        ? session.system_prompt
        : settings.global_system_prompt || null;

    if (session.space_id) {
      try {
        const ctx = await getSpaceContext(session.space_id);
        let spaceBlock = "";
        if (ctx.space.instructions) {
          spaceBlock += ctx.space.instructions + "\n\n";
        }
        const textFiles = ctx.files.filter((f) => f.kind === "text");
        if (textFiles.length > 0) {
          spaceBlock += "--- Space reference files ---\n";
          for (const f of textFiles) {
            spaceBlock += `\nFile: \`${f.name}\`\n\`\`\`\n${f.data}\n\`\`\`\n`;
          }
        }
        if (spaceBlock) {
          effectiveSystemPrompt = spaceBlock + (effectiveSystemPrompt ?? "");
        }
      } catch (e) {
        console.warn("Failed to load space context", e);
      }
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
