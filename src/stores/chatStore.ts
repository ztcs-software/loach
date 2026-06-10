import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  appendMessage,
  archiveSession,
  createSession,
  deleteArchivedSessions,
  deleteImportGroup,
  deleteMessage,
  deleteSession,
  forkSession,
  importMessages as tauriImportMessages,
  getSpaceContext,
  listMessages,
  listSessions,
  makeRequestId,
  markMessagesCompacted,
  ollamaUnloadModel,
  pinSession,
  renameSession,
  startChatStream,
  updateMessage,
  updateSessionModel as persistSessionModel,
  updateSessionParams as persistSessionParams,
  updateSessionSystemPrompt as persistSessionSystemPrompt,
} from "@/lib/tauri";
import { useToastStore } from "./toastStore";
import {
  imagesFromAttachments,
  inlineTextAttachments,
} from "@/lib/files";
import { extractMemories } from "@/lib/memory";
import { buildCompactedMarkdown } from "@/lib/export";
import {
  extractSummary,
  stripSummaryBlock,
  SUMMARY_END_TAG,
  SUMMARY_START_TAG,
} from "@/lib/contextUsage";
import { formatProviderError } from "@/lib/providerErrors";
import { getPersona } from "@/lib/personas";
import { getTone } from "@/lib/tones";
import { applyTemporalAwareness } from "@/lib/temporal";
import {
  buildFetchToolRecords,
  extractUrls,
  fetchAll,
  inlineFetchedPages,
  type FetchOutcome,
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
  type ToolCallRecord,
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
  /** Pre-stream tool-call records that should appear on the assistant
   *  bubble alongside any MCP / calculator calls the model itself makes
   *  during streaming. Currently used for web-fetch: the frontend ran
   *  the fetches before the chat request was built, and we want the
   *  same chip UX users get for model-initiated tools. Seeded into
   *  `runningBuffers.toolCalls` in `startTask` so the streaming
   *  flush / finish paths persist them on the assistant row without
   *  any extra DB write. */
  preToolCalls?: ToolCallRecord[];
}

interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  /** True after `hydrate()` finishes (whether it succeeded or fell into the
   *  catch). Used by `App.tsx` to render a skeleton while chats are loading
   *  from SQLite — without it the user briefly sees the "No chat open" CTA
   *  even when they have chats waiting on disk. */
  hydrated: boolean;
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
  /** Permanently delete every archived chat. Returns the number removed
   *  so the caller can show a toast. */
  removeAllArchived: () => Promise<number>;
  remove: (id: string) => Promise<void>;
  /** Branch a chat. `upToMessageId` omitted = copy the whole transcript
   *  ("Fork this chat" in the header); set = copy up to and including that
   *  message ("Fork from here" in the assistant message kebab). The new
   *  session is added to the store, its messages are loaded, and it is
   *  selected as the active chat. Returns the new session. */
  fork: (sourceId: string, upToMessageId?: string) => Promise<Session>;
  setSessionModel: (id: string, provider: ProviderId, model: string) => Promise<void>;
  setSessionSystemPrompt: (id: string, prompt: string) => Promise<void>;
  /** Set per-session generation parameters. Pass `null` to remove the
   *  override entirely so the session falls back to (model defaults +
   *  app defaults). */
  setSessionParams: (id: string, params: GenerationParams | null) => Promise<void>;
  /** Append parsed messages onto the end of a session's transcript as one
   *  import batch. Used by the "Import context" dialog — see
   *  `lib/importContext.ts` for the parser that produces the input shape.
   *  The batch shares one `import_group` so the transcript renders it as a
   *  single collapsible card and can remove it as a unit; `hidden` folds
   *  that card out of the transcript while the content still reaches the
   *  model. Imported context shows up in exports either way. */
  importMessages: (
    id: string,
    messages: { role: "user" | "assistant" | "system"; content: string }[],
    hidden: boolean,
  ) => Promise<void>;
  /** Remove an imported batch (every row sharing `group`) from a session,
   *  in the DB and the in-memory transcript. Used by the Remove control on
   *  the imported-context card. */
  removeImportGroup: (id: string, group: string) => Promise<void>;

  sendUserMessage: (content: string, attachments: Attachment[]) => Promise<void>;
  /** Drop the trailing assistant message in `sessionId` and re-stream a
   *  fresh reply from the same preceding user turn. No-op if the chat is
   *  already busy (running or queued), if the last message isn't an
   *  assistant turn, or if there's no preceding user turn to regenerate
   *  from. The current persona / tone / temporal settings apply — a
   *  regenerated reply uses today's settings, not the settings active
   *  when the original was produced. */
  regenerateLast: (sessionId: string) => Promise<void>;
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

  /** Session id that's currently being compacted, or null. Drives the
   *  spinner in the Context popup so the user sees that the summarizer
   *  call is in flight. At most one compaction runs at a time. */
  compactingSessionId: string | null;
  /** Summarize the older messages in a session via the same model and
   *  store the summary in `session.system_prompt` with a unique marker
   *  block, then delete the summarized messages so they no longer
   *  consume context. Earlier auto-summary blocks in `system_prompt`
   *  are replaced, not stacked. */
  compactContext: (sessionId: string) => Promise<void>;
  /** Build a compacted Markdown export without touching the session.
   *  Summarizes the ENTIRE visible context (same model + prompt as
   *  `compactContext`) into a single recap — unlike the live Compact button,
   *  no recent messages are kept verbatim, because turning the export switch
   *  on is an explicit ask to collapse everything into the summary.
   *  Read-only — nothing is persisted. Throws with a user-facing message when
   *  there's no model or fewer than COMPACT_MIN_TOTAL messages to compact. */
  exportCompactedContext: (sessionId: string) => Promise<string>;
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
  /** Ordered list of tool calls + results made during this turn. Appended
   *  on `tool_call`; the matching entry's `result` / `is_error` are
   *  filled in on `tool_result`. Persisted as JSON on the assistant
   *  message at `finishRunning` (or in real time on each tool_result
   *  event so a cancel mid-loop doesn't lose partial work). */
  toolCalls: ToolCallRecord[];
  /** Attachments produced by built-in tools mid-turn (today only `pdf`).
   *  Accumulated across `tool_result` events with non-empty `attachments`
   *  and persisted onto the assistant message's `attachments_json` at
   *  flush time so the chat UI renders them as file cards via the same
   *  path user-uploaded attachments use. */
  attachments: Attachment[];
} | null = null;

/** rAF-batched render flush state for streaming events. Rather than calling
 *  `set()` on every token / thinking / metrics delta (which used to fire
 *  100+ times a second on fast providers and re-render every chat-canvas
 *  subscriber), we accumulate into `runningBuffers` and write to the store
 *  at most once per animation frame. `MessageItem` is memoised on
 *  reference equality, so only the streaming bubble re-renders per flush.
 *
 *  Invariants:
 *   - Terminal events (done / error / cancelled) MUST call
 *     `flushPendingFrame` synchronously before tearing down, so the user
 *     sees the last few tokens before the stream's stop side-effects fire.
 *   - The flush is a no-op when `runningBuffers` is null — guards against
 *     a stale rAF firing after a cancellation cleared the buffer. */
let pendingFrame: number | null = null;
const pendingDirty = {
  content: false,
  thinking: false,
  metrics: false,
  toolCalls: false,
  attachments: false,
};

function scheduleFlush(get: Getter, set: Setter) {
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    flushPendingFrame(get, set);
  });
}

function flushPendingFrame(get: Getter, set: Setter) {
  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  const dContent = pendingDirty.content;
  const dThinking = pendingDirty.thinking;
  const dMetrics = pendingDirty.metrics;
  const dTools = pendingDirty.toolCalls;
  const dAttach = pendingDirty.attachments;
  if (!dContent && !dThinking && !dMetrics && !dTools && !dAttach) return;
  pendingDirty.content = false;
  pendingDirty.thinking = false;
  pendingDirty.metrics = false;
  pendingDirty.toolCalls = false;
  pendingDirty.attachments = false;
  const buf = runningBuffers;
  if (!buf) return;
  const task = get().runningTask;
  if (!task) return;
  const sessionId = task.sessionId;
  const msgId = buf.assistantMsgId;
  const newContent = buf.content;
  const newThinking = buf.thinking;
  const newMetrics = buf.metrics;
  // Snapshot tool calls now — `runningBuffers.toolCalls` is mutated in
  // place by the stream handlers, so we serialize at flush time to give
  // every subscriber a stable reference.
  const newToolsJson = dTools ? JSON.stringify(buf.toolCalls) : null;
  // Same snapshot pattern for attachments — produced by built-in tools
  // (pdf today) and rendered by AttachmentActions / PdfPreview via the
  // existing `attachments_json` field on the message.
  const newAttachJson = dAttach ? JSON.stringify(buf.attachments) : null;
  set((s) => {
    const next: Partial<ChatState> = {};
    if (dContent || dThinking || dTools || dAttach) {
      const list = s.messages[sessionId] ?? [];
      next.messages = {
        ...s.messages,
        [sessionId]: list.map((m) =>
          m.id === msgId
            ? {
                ...m,
                ...(dContent ? { content: newContent } : {}),
                ...(dThinking ? { thinking: newThinking } : {}),
                ...(dTools ? { tool_calls_json: newToolsJson } : {}),
                ...(dAttach ? { attachments_json: newAttachJson } : {}),
              }
            : m,
        ),
      };
    }
    if (dMetrics) {
      next.streamingByMessage = {
        ...s.streamingByMessage,
        [msgId]: newMetrics,
      };
    }
    return next;
  });
}

/** Whitelist of params we accept from a stored override blob, paired
 *  with their runtime guard. Anything not in this list — or with the
 *  wrong type — is silently dropped so a corrupted DB row (or a
 *  pre-RTM blob written by an older format) can't push e.g.
 *  `temperature: "high"` through to the provider. Booleans for
 *  `think` / `low_vram` are coerced strictly: any non-boolean value is
 *  ignored. `seed` is the only field where `null` is a meaningful
 *  payload value ("random each run"). */
const PARAM_GUARDS: {
  [K in keyof GenerationParams]: (v: unknown) => GenerationParams[K] | undefined;
} = {
  temperature: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  top_p: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  top_k: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  min_p: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  max_tokens: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  num_ctx: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  repeat_penalty: (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined,
  frequency_penalty: (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined,
  presence_penalty: (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined,
  seed: (v) => {
    if (v === null) return null;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  },
  think: (v) => (typeof v === "boolean" ? v : undefined),
  num_gpu: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  low_vram: (v) => (typeof v === "boolean" ? v : undefined),
};

function parseOverrides(json: string | null): Partial<GenerationParams> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const out: Partial<GenerationParams> = {};
  for (const key of Object.keys(PARAM_GUARDS) as (keyof GenerationParams)[]) {
    if (!(key in source)) continue;
    const guard = PARAM_GUARDS[key];
    const checked = guard?.(source[key]);
    if (checked !== undefined || key === "seed") {
      // `seed: null` is intentional; every other field treats `undefined`
      // as "drop", so we don't set the key at all in that branch.
      (out as Record<string, unknown>)[key] = checked;
    }
  }
  return out;
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
  const settingsState = useSettingsStore.getState();
  // Global Thinking default (Settings → General). Sits below model + per-model
  // prefs and the per-chat override so an explicit per-model or per-chat
  // setting still wins.
  const globalThinkLayer: Partial<GenerationParams> = isOllama
    ? { think: settingsState.thinking_default }
    : {};
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
    ...globalThinkLayer,
    ...modelDefaults,
    ...thinkLayer,
    ...spaceLayer,
    ...overrides,
  };
  // Global Low-VRAM pin (Settings → General). Ollama-only — OpenAI ignores
  // the field, so we don't bother stamping it on those requests. Stays out
  // of `params_json` deliberately: a per-chat record of "user picked this"
  // shouldn't include settings the user never touched in the panel.
  if (isOllama && settingsState.low_vram_global) {
    merged.low_vram = true;
  }
  return merged;
}

function chatHistory(messages: Message[], userText: string, images: string[]): ChatMessageIn[] {
  // Compacted messages stay visible to the user but must NOT reach the
  // model — the running auto-summary (in `session.system_prompt`) is the
  // model's substitute for them, and re-sending the originals would
  // defeat the whole point of compaction. System rows are dropped here
  // because they're sent via the dedicated `system_prompt` field, not as
  // chat turns.
  const history: ChatMessageIn[] = messages
    .filter((m) => m.role !== "system" && m.compacted_at == null)
    .map((m) => ({
      role: m.role,
      content: m.content,
      images: [],
    }));
  history.push({ role: "user", content: userText, images });
  return history;
}

/** Compaction thresholds shared by `compactContext` (which persists the
 *  result) and `exportCompactedContext` (which only builds a smaller
 *  export). KEEP_TAIL recent messages stay verbatim; we refuse to compact
 *  below MIN_TOTAL because summarizing one or two turns isn't worth the
 *  round-trip. */
const COMPACT_KEEP_TAIL = 4;
const COMPACT_MIN_TOTAL = 6;

/**
 * Run the summarization model call shared by `compactContext` and
 * `exportCompactedContext`. Builds a transcript from `toSummarize`, folds in
 * any `priorSummary` so earlier rolled-up context survives, streams the
 * model, and resolves with the trimmed summary. Throws on stream error or an
 * empty summary so each caller can surface its own message. Does not touch
 * store state — callers own any persistence.
 */
async function generateSummary(
  session: Session,
  toSummarize: Message[],
  priorSummary: string | null,
): Promise<string> {
  const transcript = toSummarize
    .map((m) => {
      const speaker = m.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${m.content}`;
    })
    .join("\n\n");

  // The existing summary represents the messages rolled up on a previous
  // round. Feed it back alongside the new transcript so the refreshed
  // summary keeps the older context instead of silently dropping it.
  const priorBlock = priorSummary
    ? `Previous summary (carry forward — do NOT discard):\n${priorSummary}\n\n`
    : "";

  const summaryPrompt = `${priorBlock}Summarize the conversation below in concise bullet points. Capture the user's goals, important decisions or conclusions, key facts established, and any unresolved threads. Output ONLY the bullets — no preamble, no closing line.

Conversation:
---
${transcript}
---`;

  const settings = useSettingsStore.getState();
  const baseUrl =
    session.provider === "ollama"
      ? settings.ollama_base_url
      : settings.openai_base_url;
  const params = readSessionParams(session);

  let summary = "";
  let streamErr: string | null = null;
  const unlistenHolder: { fn: (() => void) | null } = { fn: null };
  try {
    await new Promise<void>((resolve, reject) => {
      startChatStream(
        {
          stream_id: makeRequestId(),
          provider: session.provider,
          model: session.model,
          base_url: baseUrl,
          system_prompt: null,
          messages: [{ role: "user", content: summaryPrompt, images: [] }],
          params,
        },
        (ev) => {
          if (ev.kind === "token") {
            summary += ev.delta;
          } else if (ev.kind === "error") {
            streamErr = ev.message;
            resolve();
          } else if (ev.kind === "done" || ev.kind === "cancelled") {
            resolve();
          }
        },
      )
        .then((handle) => {
          unlistenHolder.fn = handle.unlisten;
        })
        .catch(reject);
    });
  } catch (e) {
    streamErr = e instanceof Error ? e.message : String(e);
  } finally {
    const fn = unlistenHolder.fn;
    if (fn) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  const cleanSummary = summary.trim();
  if (streamErr) throw new Error(streamErr);
  if (!cleanSummary) throw new Error("Model returned no summary.");
  return cleanSummary;
}

/**
 * Build the provider-bound `ChatRequest` shape for a session, given the
 * trailing user turn that triggers it. Resolves the effective system
 * prompt (Space instructions + memory + files, fallback chain, USER_NAME
 * substitution, temporal preamble, persona prefix, tone suffix) and folds
 * Space-level image attachments into the trailing user turn.
 *
 * Used by both `sendUserMessage` (with a freshly-persisted user turn) and
 * `regenerateLast` (with the previous user turn already in history). The
 * caller passes `history` containing every message EXCEPT the trigger user
 * turn — the function appends the trigger as the trailing user turn so
 * `images` is attached only to that one entry.
 */
async function buildTaskRequest(
  session: Session,
  sessionId: string,
  history: Message[],
  triggerContent: string,
  triggerImages: string[],
): Promise<QueueTask["request"]> {
  const settings = useSettingsStore.getState();
  const baseUrl =
    session.provider === "ollama"
      ? settings.ollama_base_url
      : settings.openai_base_url;
  const params = readSessionParams(session);

  const fallbackPrompt =
    session.system_prompt && session.system_prompt.length > 0
      ? session.system_prompt
      : settings.global_system_prompt || "";

  let effectiveSystemPrompt: string | null = fallbackPrompt || null;
  const spaceImages: string[] = [];
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
      for (const f of ctx.files) {
        if (f.kind === "image") spaceImages.push(f.data);
      }
      let memoryBlock = "";
      if (ctx.memories.length > 0) {
        memoryBlock = "--- Space memory ---\n";
        memoryBlock +=
          "Facts to remember about the user across chats in this space:\n";
        for (const m of ctx.memories) {
          memoryBlock += `- ${m.content}\n`;
        }
      }
      useSpaceStore.setState((s) => ({
        spaceMemories: { ...s.spaceMemories, [session.space_id!]: ctx.memories },
      }));
      const base = spaceInstructions || fallbackPrompt;
      const parts: string[] = [];
      if (base) parts.push(base);
      if (memoryBlock) parts.push(memoryBlock);
      if (filesBlock) parts.push(filesBlock);
      effectiveSystemPrompt = parts.length ? parts.join("\n\n") : null;
    } catch (e) {
      logger.warn("Failed to load space context", e);
    }
  }

  if (effectiveSystemPrompt) {
    effectiveSystemPrompt = effectiveSystemPrompt.replace(
      /\{\{\s*USER_NAME\s*\}\}/g,
      settings.user_name ?? "",
    );
  }

  effectiveSystemPrompt = applyTemporalAwareness(
    effectiveSystemPrompt,
    settings.temporal_awareness,
  );

  const personaId = useUIStore.getState().personaIdBySession[sessionId];
  const persona = getPersona(personaId);
  if (persona && persona.systemPrompt.length > 0) {
    effectiveSystemPrompt = effectiveSystemPrompt
      ? `${persona.systemPrompt}\n\n${effectiveSystemPrompt}`
      : persona.systemPrompt;
  }

  const toneId =
    useUIStore.getState().toneIdBySession[sessionId] ??
    settings.default_tone_id;
  const tone = getTone(toneId);
  if (tone && tone.systemPrompt.length > 0) {
    effectiveSystemPrompt = effectiveSystemPrompt
      ? `${effectiveSystemPrompt}\n\n${tone.systemPrompt}`
      : tone.systemPrompt;
  }

  const chatMessages = chatHistory(history, triggerContent, [
    ...triggerImages,
    ...spaceImages,
  ]);

  return {
    provider: session.provider,
    model: session.model,
    base_url: baseUrl,
    system_prompt: effectiveSystemPrompt,
    messages: chatMessages,
    params,
  };
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

/** How the stream ended. Used to gate "real completion" side-effects
 *  (memory extraction, the unread sidebar dot) so a user-initiated cancel
 *  doesn't act like a natural reply and pollute long-term state with a
 *  half-written turn. */
type FinishReason = "done" | "cancelled" | "error";

/** Called when a stream ends (done event, manual cancel, error, or
 *  startup error). Persists the partial assistant reply, tears down the
 *  active stream handle, clears running state, and kicks the next
 *  waiting task. Safe to call more than once — subsequent calls are
 *  no-ops because `runningTask` is null.
 *
 *  `reason` defaults to `"done"` for backwards compatibility with the
 *  startup-error path (which always emitted Done in the old shape).
 *  Callers that know they're handling a cancel pass `"cancelled"` so
 *  we can skip the memory-extraction + unread-dot side-effects that
 *  would otherwise lie about an interrupted turn. */
function finishRunning(get: Getter, set: Setter, reason: FinishReason = "done") {
  // Sync-flush any pending rAF before teardown so the final tokens are
  // visible in the UI before we null out `runningBuffers` / clear the
  // streaming state. Persistence reads from `runningBuffers` directly
  // (not from store state), so this is purely for the UI bubble — but a
  // missing flush would leave the last frame of tokens invisible until
  // the next reload of the chat.
  flushPendingFrame(get, set);
  const running = get().runningTask;
  const buf = runningBuffers;
  if (running && buf) {
    // Persist the partial assistant reply. If the DB write fails (disk
    // full, lock contention, file permissions, …) the bubble we just
    // streamed exists in memory but won't survive a reload — so surface
    // it via a toast instead of swallowing silently. Includes the error
    // message so the user has a starting point if they want to debug.
    void updateMessage({
      id: buf.assistantMsgId,
      session_id: running.sessionId,
      content: buf.content,
      thinking: buf.thinking || null,
      metrics_json: buf.metrics ? JSON.stringify(buf.metrics) : null,
      tool_calls_json:
        buf.toolCalls.length > 0 ? JSON.stringify(buf.toolCalls) : null,
      attachments_json:
        buf.attachments.length > 0 ? JSON.stringify(buf.attachments) : null,
    }).catch((e) => {
      const detail = e instanceof Error ? e.message : String(e);
      logger.error("failed to persist assistant reply", e);
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save reply",
        body: `${detail} — reload will lose this reply.`,
      });
    });
  }

  // If the chat that just finished streaming isn't the one the user is
  // currently viewing, mark it unread so the sidebar shows the accent dot.
  // We also require some content — a cancelled-on-user-message task that
  // produced no assistant output shouldn't pretend to be a "new reply".
  // And we explicitly gate on `reason === "done"`: a user-initiated cancel
  // shouldn't pop the unread dot, because the user just told us they were
  // done with this turn.
  const activeId = get().activeSessionId;
  const finishedId = running?.sessionId;
  const producedContent = !!buf && buf.content.trim().length > 0;
  let unreadPatch: Record<string, boolean> | null = null;
  if (
    reason === "done" &&
    finishedId &&
    producedContent &&
    finishedId !== activeId
  ) {
    unreadPatch = { ...get().unread, [finishedId]: true };
  }

  // Snapshot the buffer + task before we null out `runningBuffers` so the
  // memory extractor (kicked off below) can read the assistant text. The
  // extractor runs *after* state cleanup so it never blocks the queue
  // promotion or the UI returning to idle.
  //
  // Skip extraction entirely on cancel / error: the turn is incomplete
  // and the assistant text is, by definition, not what the model meant
  // to say. Saving facts from a half-stream would poison long-term
  // memory with nonsense the user explicitly opted out of.
  const memorySnapshot = (() => {
    if (reason !== "done") return null;
    if (!running || !buf || !producedContent) return null;
    if (!finishedId) return null;
    const session = get().sessions.find((s) => s.id === finishedId);
    if (!session?.space_id) return null;
    const space = useSpaceStore.getState().spaces.find((s) => s.id === session.space_id);
    if (!space || !space.memory_enabled) return null;
    // Pull the user message that triggered this turn so the extractor sees
    // both halves of the exchange. `userMsgId` was captured when the task
    // was enqueued, so it's always one of the persisted messages.
    const messages = get().messages[finishedId] ?? [];
    const userMsg = messages.find((m) => m.id === running.userMsgId);
    if (!userMsg) return null;
    return {
      spaceId: session.space_id,
      sessionId: finishedId,
      assistantMessageId: buf.assistantMsgId,
      userText: userMsg.content,
      assistantText: buf.content,
      provider: running.request.provider,
      model: running.request.model,
      baseUrl: running.request.base_url,
    };
  })();

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

  // Fire-and-forget memory extraction. Runs after the queue head has been
  // promoted so the user's next message starts streaming without waiting on
  // us; failures are logged inside the extractor and never bubble up.
  if (memorySnapshot) {
    void extractMemories(memorySnapshot).catch((e) => {
      logger.warn("memory extraction failed", e);
    });
  }
}

/** Promotes the head of the waiting queue to be the running task. Deferred
 *  via `queueMicrotask` so we don't try to start a new stream inside the
 *  same tick as the previous `done` event handler.
 *
 *  Re-promote happens inside `.finally` rather than from inside `startTask`
 *  — if `startTask`'s catch block called `promoteQueueHead` directly, the
 *  nested microtask would see `dispatching === true` (the outer call's flag
 *  hadn't been cleared yet because `.finally` runs *after* the catch body)
 *  and bail. The queue would then sit idle until something else nudged it.
 *  Releasing the lock first and then re-promoting closes that window. */
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
      .catch((err) => logger.error("queued task start failed", err))
      .finally(() => {
        dispatching = false;
        // Re-check the queue now that the dispatch lock is free. On the
        // success path `runningTask` will still be set (the stream is
        // running) and the inner guards bail. On the failure path
        // `runningTask` was already cleared by `startTask`, so the next
        // waiter is picked up here.
        promoteQueueHead(get, set);
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
    // and move on to the next — the .finally hook in `promoteQueueHead`'s
    // caller will pick the next waiter once the dispatch lock is released.
    logger.error("failed to create assistant placeholder", e);
    return;
  }

  // Seed pre-stream tool-call records (e.g. web-fetch outcomes) onto
  // the assistant bubble before any token arrives. The optimistic
  // `assistantMsg` carries them so the chip appears instantly; the
  // `runningBuffers.toolCalls` array is the source the streaming
  // flush + `finishRunning` persistence path both read, so any MCP /
  // calculator calls the model makes during the turn append to the
  // same list and land on the assistant row alongside the seeds.
  //
  // Also persist them to disk immediately. `finishRunning` would write
  // them at stream end, but the startup-error catch below replaces the
  // row's content without touching `tool_calls_json` — so a request
  // that fails to connect (bad URL, unreachable Ollama, expired key)
  // would otherwise lose the chips on next reload. The follow-up
  // `update_message` is COALESCE-safe; the eventual finish-path write
  // simply overrides with any MCP / calculator calls that appended.
  const preCalls = task.preToolCalls ?? [];
  if (preCalls.length > 0) {
    const preCallsJson = JSON.stringify(preCalls);
    assistantMsg = { ...assistantMsg, tool_calls_json: preCallsJson };
    void updateMessage({
      id: assistantMsg.id,
      session_id: sessionId,
      content: "",
      tool_calls_json: preCallsJson,
    }).catch((e) =>
      logger.warn("persist pre-stream tool records failed", e),
    );
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
    toolCalls: [...preCalls],
    attachments: [],
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
        // Drop events from a stream whose task is no longer the running one.
        // A cancel during the connect window (or a superseding task) clears or
        // replaces `runningTask` and the module-level `runningBuffers` before
        // this stream's backend run has been told to stop — without this
        // identity check a late token from the old stream would be written
        // into the NEW task's buffer, and an old `done`/`error` would tear the
        // new task down mid-stream.
        if (get().runningTask?.id !== task.id) return;
        const buf = runningBuffers;
        if (!buf) return; // cancelled between events
        if (ev.kind === "thinking") {
          buf.thinking += ev.delta;
          pendingDirty.thinking = true;
          scheduleFlush(get, set);
        } else if (ev.kind === "token") {
          buf.content += ev.delta;
          pendingDirty.content = true;
          scheduleFlush(get, set);
        } else if (ev.kind === "metrics") {
          buf.metrics = {
            tokens: ev.tokens,
            elapsed_ms: ev.elapsed_ms,
            tokens_per_second: ev.tokens_per_second,
          };
          pendingDirty.metrics = true;
          scheduleFlush(get, set);
        } else if (ev.kind === "tool_call") {
          buf.toolCalls.push({
            id: ev.id,
            server_id: ev.server_id,
            server_name: ev.server_name,
            tool: ev.tool,
            arguments: ev.arguments,
            result: null,
            is_error: false,
          });
          pendingDirty.toolCalls = true;
          scheduleFlush(get, set);
        } else if (ev.kind === "tool_result") {
          const existing = buf.toolCalls.find((c) => c.id === ev.id);
          if (existing) {
            existing.result = ev.content;
            existing.is_error = ev.is_error;
          } else {
            // Defensive: a tool_result without a matching tool_call should
            // never happen (Rust emits the pair), but if it does, surface
            // the result as a standalone block rather than dropping it.
            buf.toolCalls.push({
              id: ev.id,
              server_id: "",
              server_name: "",
              tool: "(unknown)",
              arguments: {},
              result: ev.content,
              is_error: ev.is_error,
            });
          }
          pendingDirty.toolCalls = true;
          // Append any attachments the tool produced (today only the
          // built-in `pdf` tool fills this). Accumulated across results
          // so a multi-call turn ("create one PDF, then another") lands
          // both on the assistant message.
          if (ev.attachments && ev.attachments.length > 0) {
            buf.attachments.push(...ev.attachments);
            pendingDirty.attachments = true;
          }
          scheduleFlush(get, set);
        } else if (ev.kind === "error") {
          // Wrap raw provider error in a sentence the user can act on. We
          // know the provider + URL here from `task.request`, so the result
          // tells the user which endpoint failed and (often) how to fix it.
          const friendly = formatProviderError({
            provider: task.request.provider,
            baseUrl: task.request.base_url,
            raw: ev.message,
          });
          buf.content += `\n\n_⚠ ${friendly}_`;
          pendingDirty.content = true;
          // Sync-flush so the error tail is visible before teardown.
          flushPendingFrame(get, set);
          // Providers emit Error and then stop without a trailing Done, so
          // the streaming state would otherwise stay set forever and freeze
          // the input box in "Replying…" mode.
          finishRunning(get, set, "error");
        } else if (ev.kind === "cancelled") {
          // User-initiated stop. Same teardown as done, but flagged so
          // `finishRunning` skips the memory + unread side-effects.
          finishRunning(get, set, "cancelled");
        } else if (ev.kind === "done") {
          finishRunning(get, set, "done");
        }
      },
    );
    if (get().runningTask?.id === task.id) {
      set({ activeStream: { stop: handle.stop, unlisten: handle.unlisten } });
    } else {
      // Cancelled or superseded during the connect window: the backend stream
      // is live but orphaned. Tear it down rather than installing a handle
      // that would leak this stream and could clobber a successor task's
      // `activeStream` (leaving the new stream uncancellable).
      try {
        handle.unlisten();
      } catch {
        /* ignore */
      }
      void handle.stop();
    }
  } catch (e) {
    logger.error("startChatStream failed", e);
    // If this task is no longer the running one, a cancel/supersede during the
    // connect window already tore it down (and another task may now own the
    // streaming state). Bail before patching an error bubble or resetting
    // state we no longer own.
    if (get().runningTask?.id !== task.id) return;
    // The placeholder assistant row was created above so the bubble could
    // show "thinking…" while we connected. Now that the connection itself
    // failed, replace its contents with a visible error message instead of
    // leaving a blank assistant bubble in the transcript (and the DB row
    // it backs). Best-effort — if the DB write fails too, the in-memory
    // patch still keeps the bubble informative until the next reload.
    const errorMsg = e instanceof Error ? e.message : String(e);
    // Same provider-context formatting as in-stream errors. Most "connect
    // refused" / TLS failures land here rather than in the `kind: error`
    // branch because reqwest fails before the SSE handshake completes.
    const friendly = formatProviderError({
      provider: task.request.provider,
      baseUrl: task.request.base_url,
      raw: errorMsg,
    });
    const errorContent = `_⚠ ${friendly}_`;
    updateMessage({
      id: assistantMsg.id,
      session_id: sessionId,
      content: errorContent,
      thinking: null,
      metrics_json: null,
    }).catch((upErr) => {
      const detail = upErr instanceof Error ? upErr.message : String(upErr);
      logger.error("failed to persist startup-error placeholder", upErr);
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save error placeholder",
        body: `${detail} — the bubble will revert on reload.`,
      });
    });

    runningBuffers = null;
    set((s) => {
      const sbm = { ...s.streamingByMessage };
      delete sbm[assistantMsg.id];
      return {
        activeStream: null,
        isStreaming: false,
        streamingSessionId: null,
        runningTask: null,
        streamingByMessage: sbm,
        messages: {
          ...s.messages,
          [sessionId]: (s.messages[sessionId] ?? []).map((m) =>
            m.id === assistantMsg.id ? { ...m, content: errorContent } : m,
          ),
        },
      };
    });
    // The .finally chain on `promoteQueueHead`'s caller will re-promote
    // once the dispatch lock is released — calling it from here would
    // queue a microtask while `dispatching` is still set and the nested
    // call would silently bail.
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
export function resolveDefaultModelChoice(
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
  hydrated: false,
  messages: {},
  streamingByMessage: {},
  activeStream: null,
  isStreaming: false,
  streamingSessionId: null,
  runningTask: null,
  queue: [],
  unread: {},
  compactingSessionId: null,

  hydrate: async () => {
    try {
      const sessions = await listSessions();
      set({ sessions });

      // Remove all empty sessions (no messages) on startup, keep at most one.
      // Archived sessions are left alone even if empty — the user explicitly
      // moved them to the archive and shouldn't have them silently culled.
      //
      // Fan out the per-session message reads in parallel — they're
      // independent IPC calls and the prior sequential await was the dominant
      // cost of `hydrate()` for users with many chats.
      const loaded = await Promise.all(
        sessions.map((s) => listMessages(s.id).then((msgs) => ({ s, msgs }))),
      );
      const messageMap: Record<string, Message[]> = {};
      const emptySessions: Session[] = [];
      for (const { s, msgs } of loaded) {
        messageMap[s.id] = msgs;
        if (msgs.length === 0 && !s.archived_at) emptySessions.push(s);
      }
      set((st) => ({ messages: { ...st.messages, ...messageMap } }));

      // Delete all empty sessions except the first (most recent).
      // `emptySessions` preserves the iteration order of `loaded`, which
      // preserves the order of `sessions`, which is what `list_sessions`
      // returned. The Rust query is
      //   SELECT … FROM sessions ORDER BY updated_at DESC
      // (see `db::list_sessions`) so `emptySessions[0]` is the most-
      // recently-touched empty chat. If that ORDER BY ever changes,
      // revisit this loop — the "keep most recent" invariant breaks
      // silently otherwise.
      for (let i = 1; i < emptySessions.length; i++) {
        await deleteSession(emptySessions[i].id);
      }
      if (emptySessions.length > 1) {
        const remaining = sessions.filter(
          (s) => !emptySessions.slice(1).some((e) => e.id === s.id),
        );
        set({ sessions: remaining });
      }

      // Pick a session to land on: prefer the surviving empty chat (so a
      // half-typed welcome screen is preserved across restarts), otherwise
      // fall back to the most recent non-archived chat. If neither exists
      // we leave activeSessionId null and let the NoChatState CTA take
      // over — the user explicitly emptied their sidebar and we shouldn't
      // silently re-create a chat behind their back. Onboarding still
      // creates the very first chat from `onboardingStore.complete()`.
      if (emptySessions.length > 0) {
        await get().selectSession(emptySessions[0].id);
      } else {
        const remaining = get().sessions;
        const nextLive = remaining.find((s) => !s.archived_at);
        if (nextLive) await get().selectSession(nextLive.id);
      }
    } catch (e) {
      logger.error("chat hydrate failed", e);
    } finally {
      // Flip the flag regardless of success — if hydrate threw, the user
      // sees the "No chat open" CTA, which is the correct empty state.
      // Leaving `hydrated=false` here would keep the skeleton up forever.
      set({ hydrated: true });
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
      // Every caller fires this without awaiting (`void select(id)`), so an
      // unguarded reject here surfaces only as an unhandled promise rejection
      // and strands the chat empty with no feedback. Mirror the other store
      // actions: log + toast so a failed read is visible and retryable.
      try {
        const msgs = await listMessages(id);
        set((s) => ({ messages: { ...s.messages, [id]: msgs } }));
      } catch (e) {
        logger.error("failed to load messages for session", e);
        useToastStore.getState().push({
          kind: "error",
          title: "Couldn't open chat",
          body: e instanceof Error ? e.message : String(e),
        });
      }
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
    // If the user picked a persona on the welcome screen (where no session
    // existed yet), `pendingPersonaId` carries the id across — but persona
    // text is now layered in at send time, not seeded into `system_prompt`.
    // The session's `system_prompt` stays for free-form per-chat instructions
    // the user types into the parameters panel.
    const pendingPersonaId = useUIStore.getState().consumePendingPersona();
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
    if (pendingPersonaId) {
      useUIStore.getState().setSessionPersona(session.id, pendingPersonaId);
    }
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
      // normal list. The chat surface falls back to the empty-state CTA.
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

  fork: async (sourceId, upToMessageId) => {
    const session = await forkSession({
      source_session_id: sourceId,
      up_to_message_id: upToMessageId ?? null,
    });
    const msgs = await listMessages(session.id);
    set((s) => ({
      sessions: [session, ...s.sessions],
      messages: { ...s.messages, [session.id]: msgs },
      activeSessionId: session.id,
    }));
    // Warm the new chat's model defaults so the parameter panel reflects
    // the right values without a delayed round-trip — same as `newSession`.
    if (session.provider === "ollama" && session.model) {
      void useModelsStore.getState().loadModelDefaults(session.model);
    }
    return session;
  },

  removeAllArchived: async () => {
    const n = await deleteArchivedSessions();
    set((s) => {
      const archivedIds = new Set(
        s.sessions.filter((x) => x.archived_at != null).map((x) => x.id),
      );
      if (archivedIds.size === 0) return s;
      const sessions = s.sessions.filter((x) => !archivedIds.has(x.id));
      const messages = { ...s.messages };
      for (const id of archivedIds) delete messages[id];
      // Defensive: if activeSessionId somehow points at an archived chat
      // (deep link, restored state), drop the selection — the underlying
      // row is gone.
      const active =
        s.activeSessionId && archivedIds.has(s.activeSessionId)
          ? null
          : s.activeSessionId;
      return { sessions, messages, activeSessionId: active };
    });
    return n;
  },

  setSessionModel: async (id, provider, model) => {
    const prev = get().sessions.find((x) => x.id === id);
    if (!prev) return;

    // Persist FIRST. A failed write must not flip the dropdown — otherwise
    // the user thinks the model changed when in fact the next chat send
    // would still go to the old one (or, worse, to a model whose params
    // we'd loaded as a side effect).
    try {
      await persistSessionModel({ id, provider, model });
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't change model",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }

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
    if (prev.provider === "ollama" && prev.model && prev.model !== model) {
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
    // Persist first (called on textarea blur, so once-per-action — the IPC
    // round-trip is invisible to the user).
    try {
      await persistSessionSystemPrompt({ id, prompt });
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save instructions",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, system_prompt: prompt } : x,
      ),
    }));
  },

  setSessionParams: async (id, params) => {
    const next = params === null ? null : JSON.stringify(params);
    // Sliders fire many events during a drag, so update the UI optimistically
    // and persist in the background. A failed write surfaces a toast — we
    // deliberately do NOT revert the slider mid-drag because that would be
    // jarring; the user can re-drag if the chip tells them the save failed.
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, params_json: next } : x,
      ),
    }));
    try {
      await persistSessionParams({ id, params_json: next });
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save parameters",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  },

  importMessages: async (id, parsed, hidden) => {
    if (parsed.length === 0) return;
    // One round-trip inserts the whole batch under a shared `import_group`
    // (timestamps stepped monotonically in the backend). We append to the
    // local cache only after it resolves so a backend failure doesn't leave
    // ghost messages in the UI.
    const created = await tauriImportMessages({
      session_id: id,
      messages: parsed,
      hidden,
    });
    set((s) => ({
      messages: {
        ...s.messages,
        [id]: [...(s.messages[id] ?? []), ...created],
      },
    }));
  },

  removeImportGroup: async (id, group) => {
    await deleteImportGroup(id, group);
    set((s) => ({
      messages: {
        ...s.messages,
        [id]: (s.messages[id] ?? []).filter((m) => m.import_group !== group),
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
    //
    // `fetchOutcomes` survives the block so the chip persistence below can
    // build a `ToolCallRecord[]` from it and attach the same call/result
    // chip UX the calculator and MCP tools get. Without that, web fetch
    // was the only "tool" that ran silently — no indication in the UI
    // that the user's prompt had been augmented with page content.
    let fetchOutcomes: FetchOutcome[] = [];
    {
      const s = useSettingsStore.getState();
      if (s.web_fetch_enabled) {
        const urls = extractUrls(rawContent);
        if (urls.length > 0) {
          try {
            fetchOutcomes = await fetchAll(urls);
            inlinedContent = inlineFetchedPages(inlinedContent, fetchOutcomes);
          } catch (e) {
            // fetchAll itself never throws, but be defensive — a thrown
            // exception here would eat the whole submit, and we'd rather
            // send the prompt without the fetched context than not at all.
            logger.warn("web fetch step failed", e);
          }
        }
      }
    }
    const fetchToolRecords =
      fetchOutcomes.length > 0 ? buildFetchToolRecords(fetchOutcomes) : [];

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
    const history = get().messages[sessionId] ?? [];
    // Drop the just-inserted user message from the ambient history; we'll
    // re-add it as the trailing chat message so `images` is attached.
    const trimmed = history.filter((m) => m.id !== userMsg.id);
    const request = await buildTaskRequest(
      session,
      sessionId,
      trimmed,
      inlinedContent,
      images,
    );

    const task: QueueTask = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      userMsgId: userMsg.id,
      request,
      preToolCalls: fetchToolRecords.length > 0 ? fetchToolRecords : undefined,
    };

    // 3. Dispatch. If nothing is running globally, start immediately.
    //    Otherwise park in the waiting queue and let the runner pick us
    //    up when the current task ends. The trailing `promoteQueueHead`
    //    on the direct-start branch covers the case where startTask
    //    failed synchronously: it nulls `runningTask` in its catch but
    //    won't re-promote on its own (the `.finally` re-promote in
    //    `promoteQueueHead` only fires when a task was dispatched from
    //    there). Without this nudge, a synchronous startup failure
    //    would strand any tasks queued in the meantime.
    if (!get().runningTask) {
      await startTask(task, get, set);
      promoteQueueHead(get, set);
    } else {
      set((s) => ({ queue: [...s.queue, task] }));
    }
  },

  regenerateLast: async (sessionId) => {
    const state = get();
    // Hard cap mirrors `sendUserMessage` — one in-flight task per chat.
    // The UI hides the menu item in this state too; belt-and-suspenders.
    if (state.runningTask?.sessionId === sessionId) return;
    if (state.queue.some((t) => t.sessionId === sessionId)) return;

    const messages = state.messages[sessionId] ?? [];
    if (messages.length < 2) return;
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (last.role !== "assistant") return;
    const userMsg = messages[lastIdx - 1];
    if (userMsg.role !== "user") return;
    // Don't regenerate an imported turn. The assistant row belongs to an
    // import group the import-card renderer treats as atomic; deleting it here
    // would desync the rendered card from its remaining DB rows.
    if (last.import_group != null) return;

    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session || !session.model) return;

    // Drop the assistant turn from DB + store first. Same model as
    // `sendUserMessage`'s placeholder: a fresh assistant row is created
    // when the task actually starts streaming (inside `startTask`), so
    // a cancel-while-waiting doesn't leave an empty bubble behind.
    try {
      await deleteMessage(last.id, sessionId);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't regenerate",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    set((s) => {
      const sbm = { ...s.streamingByMessage };
      delete sbm[last.id];
      return {
        messages: {
          ...s.messages,
          [sessionId]: (s.messages[sessionId] ?? []).filter(
            (m) => m.id !== last.id,
          ),
        },
        streamingByMessage: sbm,
      };
    });

    // Re-extract images from the original user turn's attachments_json
    // so the new request reaches the model with the same multimodal
    // context as the original send.
    let triggerImages: string[] = [];
    if (userMsg.attachments_json) {
      try {
        const atts = JSON.parse(userMsg.attachments_json) as Attachment[];
        triggerImages = imagesFromAttachments(atts);
      } catch {
        /* malformed JSON — proceed without images */
      }
    }

    const history = (get().messages[sessionId] ?? []).filter(
      (m) => m.id !== userMsg.id,
    );
    const request = await buildTaskRequest(
      session,
      sessionId,
      history,
      userMsg.content,
      triggerImages,
    );

    const task: QueueTask = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      userMsgId: userMsg.id,
      request,
    };

    if (!get().runningTask) {
      await startTask(task, get, set);
      promoteQueueHead(get, set);
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
          logger.error("stream stop failed", e);
        }
      }
      finishRunning(get, set, "cancelled");
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

    // Nothing running → treat promote like a direct start. Same nudge
    // pattern as in `submit`: a synchronous startup failure would
    // otherwise leave the queue stalled.
    if (!state.runningTask) {
      const task = state.queue.find((t) => t.sessionId === sessionId);
      if (!task) return;
      set((s) => ({ queue: s.queue.filter((t) => t.id !== task.id) }));
      await startTask(task, get, set);
      promoteQueueHead(get, set);
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
        logger.error("stream stop failed", e);
      }
    }
    finishRunning(get, set, "cancelled");
  },

  compactContext: async (sessionId) => {
    const state = get();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (!session.model) {
      useToastStore.getState().push({
        kind: "error",
        title: "Can't compact",
        body: "Pick a model first.",
      });
      return;
    }
    if (state.compactingSessionId) return;
    if (
      state.runningTask?.sessionId === sessionId ||
      state.queue.some((t) => t.sessionId === sessionId)
    ) {
      useToastStore.getState().push({
        kind: "info",
        title: "Chat is busy",
        body: "Wait for the current reply before compacting.",
      });
      return;
    }

    const all = state.messages[sessionId] ?? [];
    // Already-compacted rows have a summary representing them in the
    // system prompt — re-summarising them would just feed the model
    // their own summary twice. Build the candidate list from non-system,
    // not-yet-compacted messages only.
    const visible = all.filter(
      (m) => m.role !== "system" && m.compacted_at == null,
    );
    // Keep the most recent COMPACT_KEEP_TAIL messages untouched so the user
    // still has their latest exchange visible verbatim. Anything below that
    // we'd be summarizing two turns — not worth the round-trip.
    if (visible.length < COMPACT_MIN_TOTAL) {
      useToastStore.getState().push({
        kind: "info",
        title: "Not enough to compact",
        body: `Compaction needs at least ${COMPACT_MIN_TOTAL} messages.`,
      });
      return;
    }
    const toSummarize = visible.slice(0, visible.length - COMPACT_KEEP_TAIL);

    set({ compactingSessionId: sessionId });

    let cleanSummary: string;
    try {
      cleanSummary = await generateSummary(
        session,
        toSummarize,
        extractSummary(session.system_prompt ?? null),
      );
    } catch (e) {
      set({ compactingSessionId: null });
      useToastStore.getState().push({
        kind: "error",
        title: "Compaction failed",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Stash the summary inside `session.system_prompt` using a unique
    // marker block. Re-compacting strips the previous block first so
    // the prompt doesn't grow unboundedly. The user can still see and
    // edit the block in the Parameters panel's "Custom instructions"
    // textarea, which is intentional — compaction shouldn't be a black
    // box.
    const existing = session.system_prompt ?? "";
    const stripped = stripSummaryBlock(existing);
    const block = `${SUMMARY_START_TAG}\n${cleanSummary}\n${SUMMARY_END_TAG}\n\n`;
    const newPrompt = block + stripped;

    // Persist the system-prompt update straight to the backend rather
    // than going through `setSessionSystemPrompt` — that action does
    // its own `set()` for the new prompt, which would land BEFORE the
    // message deletions below. The UsageBar reads system_prompt and
    // messages together, so a split update flashes a misleading "bigger
    // than before" reading for one render. Doing both DB writes here
    // and then a single combined state update keeps the bar's
    // re-render aligned with the final state.
    try {
      await persistSessionSystemPrompt({ id: sessionId, prompt: newPrompt });
    } catch (e) {
      set({ compactingSessionId: null });
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save summary",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Mark the summarised messages as compacted in the DB. They stay in
    // the rows table so the user can still scroll back through them —
    // only the chat-history builder ignores them on the next request.
    // Failure is non-fatal: the summary is already in place, so a
    // missed mark just means the next send carries those originals
    // alongside the summary (extra context, not wrong context).
    const summarizedIds = toSummarize.map((m) => m.id);
    const compactedAt = Date.now();
    try {
      await markMessagesCompacted({ session_id: sessionId, ids: summarizedIds });
    } catch (e) {
      logger.warn("compact: failed to mark messages compacted", e);
    }
    // Single, combined state update: the new system_prompt and the
    // freshly-flagged messages land in one render. The UsageBar /
    // popover re-render exactly once and see the new (smaller) numbers
    // without an intermediate "bigger" flash. The popover is left open
    // on purpose so the user sees the change happen.
    const flagged = new Set(summarizedIds);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, system_prompt: newPrompt } : x,
      ),
      messages: {
        ...s.messages,
        [sessionId]: (s.messages[sessionId] ?? []).map((m) =>
          flagged.has(m.id) && m.compacted_at == null
            ? { ...m, compacted_at: compactedAt }
            : m,
        ),
      },
      compactingSessionId: null,
    }));

    useToastStore.getState().push({
      kind: "info",
      title: "Context compacted",
      body: `Summarized ${toSummarize.length} earlier messages. They stay visible above the divider; the model only sees the summary.`,
    });
  },

  exportCompactedContext: async (sessionId) => {
    const state = get();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("Chat not found.");
    if (!session.model) throw new Error("Pick a model first.");

    // Mirror `compactContext`'s candidate selection: already-compacted and
    // system rows are excluded — the former are folded into the carried-
    // forward summary, the latter ride along in the system prompt.
    const all = state.messages[sessionId] ?? [];
    const visible = all.filter(
      (m) => m.role !== "system" && m.compacted_at == null,
    );
    // Apply the same minimum-size floor as the live Compact button. Below it,
    // summarizing isn't worth a model round-trip (and produces a worse export
    // than just including the messages verbatim), so reject with a clear
    // message rather than spending a request to "summarize" a 1-2 message chat.
    if (visible.length < COMPACT_MIN_TOTAL) {
      throw new Error(
        `Not enough to compact — needs at least ${COMPACT_MIN_TOTAL} messages.`,
      );
    }
    // Unlike the live Compact button (which keeps the most recent
    // COMPACT_KEEP_TAIL messages verbatim), the export path summarizes the
    // ENTIRE context — the switch being ON is an explicit ask to compact
    // everything into the summary, with no raw tail left behind.
    const toSummarize = visible;

    const summary = await generateSummary(
      session,
      toSummarize,
      extractSummary(session.system_prompt ?? null),
    );

    return buildCompactedMarkdown(session, summary, []);
  },
}));
