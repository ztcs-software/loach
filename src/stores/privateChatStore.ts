import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  makeRequestId,
  startChatStream,
} from "@/lib/tauri";
import {
  imagesFromAttachments,
  inlineTextAttachments,
} from "@/lib/files";
import { getPersona } from "@/lib/personas";
import { getTone } from "@/lib/tones";
import { useSettingsStore } from "./settingsStore";
import {
  type Attachment,
  type ChatMessageIn,
  type GenerationParams,
  type MessageMetrics,
} from "@/types";

/** Ephemeral message used inside Private Chat. NOT a DB-backed `Message` —
 *  this never gets persisted, and the schema is deliberately a subset so a
 *  mistake elsewhere can't accidentally pipe a private message through the
 *  same persistence helpers as a regular chat. */
export interface PrivateMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  attachments?: Attachment[];
  metrics?: MessageMetrics | null;
}

interface ActiveStream {
  stop: () => Promise<void>;
  unlisten: () => void;
}

interface PrivateChatState {
  open: boolean;
  messages: PrivateMessage[];
  isStreaming: boolean;
  /** Ollama model id picked for this private session. Persists in memory
   *  for the lifetime of the overlay only — closing the overlay wipes it. */
  model: string;
  params: Partial<GenerationParams>;
  /** Whether the right-side parameters sidebar is visible. Persists across
   *  opens but resets on wipe — same lifetime as `model`, treated as a UI
   *  preference rather than chat content. */
  paramsOpen: boolean;
  /** Selected persona id, or `null` to skip the persona layer. */
  personaId: string | null;
  /** Selected tone id, or `null` to fall back to settings.default_tone_id. */
  toneId: string | null;
  /** Free-form per-chat instructions, layered between persona prefix and
   *  tone suffix at send time. Reset by wipe(). */
  additionalSystemPrompt: string;
  /** Tracks the in-flight stream so closing the overlay (or sending a new
   *  message — but the UI gates that off) can tear it down cleanly. */
  activeStream: ActiveStream | null;
  /** The assistant placeholder currently being filled by the stream, if any.
   *  We mutate this message in place on each token event. */
  streamingMessageId: string | null;

  /** Open the overlay. Caller (PrivateChat trigger in TitleBar) is
   *  responsible for cancelling any running regular chat first; this store
   *  is intentionally agnostic of the regular chatStore so the two
   *  surfaces stay decoupled. */
  setOpen: (open: boolean) => void;
  setModel: (model: string) => void;
  setParams: (params: Partial<GenerationParams>) => void;
  setParamsOpen: (open: boolean) => void;
  setPersona: (id: string | null) => void;
  setTone: (id: string | null) => void;
  setAdditionalSystemPrompt: (text: string) => void;
  send: (rawContent: string, attachments: Attachment[]) => Promise<void>;
  cancel: () => Promise<void>;
  /** Hard reset — wipes messages, params, persona/tone/prompt, model, and
   *  aborts any stream. Called on close so nothing about the conversation
   *  (or the prompt-shaping choices that produced it) survives. */
  wipe: () => void;
}

function randomId(): string {
  return `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Compose the effective system prompt the model should see, layering in
 *  the same order chatStore.buildTaskRequest does for the regular chat:
 *  persona prefix → user-authored instructions → tone suffix. Returns null
 *  when every layer is empty so the request stays clean.
 *
 *  Intentionally simpler than buildTaskRequest: no Space context, no
 *  USER_NAME substitution, no temporal preamble. Those layers exist for
 *  persistent chats and don't belong in an ephemeral surface. */
function composeSystemPrompt(args: {
  personaId: string | null;
  toneId: string | null;
  additional: string;
  fallbackToneId: string | null | undefined;
}): string | null {
  const persona = getPersona(args.personaId);
  const tone = getTone(args.toneId ?? args.fallbackToneId);
  const base = args.additional.trim();

  let out = base.length > 0 ? base : "";
  if (persona && persona.systemPrompt.length > 0) {
    out = out ? `${persona.systemPrompt}\n\n${out}` : persona.systemPrompt;
  }
  if (tone && tone.systemPrompt.length > 0) {
    out = out ? `${out}\n\n${tone.systemPrompt}` : tone.systemPrompt;
  }
  return out.length > 0 ? out : null;
}

export const usePrivateChatStore = create<PrivateChatState>((set, get) => ({
  open: false,
  messages: [],
  isStreaming: false,
  model: "",
  params: {},
  paramsOpen: false,
  personaId: null,
  toneId: null,
  additionalSystemPrompt: "",
  activeStream: null,
  streamingMessageId: null,

  setOpen: (open) => set({ open }),
  setModel: (model) => set({ model }),
  setParams: (params) => set({ params }),
  setParamsOpen: (paramsOpen) => set({ paramsOpen }),
  setPersona: (personaId) => set({ personaId }),
  setTone: (toneId) => set({ toneId }),
  setAdditionalSystemPrompt: (additionalSystemPrompt) =>
    set({ additionalSystemPrompt }),

  send: async (rawContent, attachments) => {
    const state = get();
    if (state.isStreaming) return;
    if (!state.model) {
      throw new Error("Pick an Ollama model to start the conversation.");
    }

    // Resolve Ollama base URL from the regular settings — the picker requires
    // Ollama to be reachable, so this read is safe.
    const settings = useSettingsStore.getState();
    const baseUrl = settings.ollama_base_url;

    const systemPrompt = composeSystemPrompt({
      personaId: state.personaId,
      toneId: state.toneId,
      additional: state.additionalSystemPrompt,
      fallbackToneId: settings.default_tone_id,
    });

    const inlinedContent = inlineTextAttachments(rawContent, attachments);
    const images = imagesFromAttachments(attachments);

    const userMsg: PrivateMessage = {
      id: randomId(),
      role: "user",
      content: inlinedContent,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    const assistantMsg: PrivateMessage = {
      id: randomId(),
      role: "assistant",
      content: "",
      thinking: "",
      metrics: null,
    };

    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      isStreaming: true,
      streamingMessageId: assistantMsg.id,
    }));

    // Build the chat history snapshot from in-memory messages only. The user
    // turn we just appended is the trailing entry with images attached; all
    // prior turns flow in as plain text.
    const history: ChatMessageIn[] = get()
      .messages.filter((m) => m.id !== userMsg.id && m.id !== assistantMsg.id)
      .map((m) => ({ role: m.role, content: m.content, images: [] }));
    history.push({ role: "user", content: inlinedContent, images });

    const streamId = makeRequestId();
    const assistantId = assistantMsg.id;

    // Update helper that mutates only the assistant placeholder. Identity
    // stability matters less here than in the main chat (no global runner,
    // single open surface) so we do a simple map() per event.
    const patchAssistant = (
      patch: (m: PrivateMessage) => Partial<PrivateMessage>,
    ) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, ...patch(m) } : m,
        ),
      }));
    };

    const teardown = () => {
      const handle = get().activeStream;
      if (handle) {
        try {
          handle.unlisten();
        } catch {
          /* already torn down */
        }
      }
      set({
        activeStream: null,
        isStreaming: false,
        streamingMessageId: null,
      });
    };

    try {
      const handle = await startChatStream(
        {
          stream_id: streamId,
          provider: "ollama",
          model: state.model,
          base_url: baseUrl,
          system_prompt: systemPrompt,
          messages: history,
          params: state.params,
          // Tell the backend to skip MCP tool aggregation. Without this
          // the model could autonomously call any enabled MCP server and
          // hand over prompt content as tool arguments — silently
          // breaking the "nothing leaves this box" promise the overlay
          // makes. See `commands::chat_stream`.
          private: true,
        },
        (ev) => {
          if (ev.kind === "token") {
            patchAssistant((m) => ({ content: (m.content ?? "") + ev.delta }));
          } else if (ev.kind === "thinking") {
            patchAssistant((m) => ({
              thinking: (m.thinking ?? "") + ev.delta,
            }));
          } else if (ev.kind === "metrics") {
            patchAssistant(() => ({
              metrics: {
                tokens: ev.tokens,
                elapsed_ms: ev.elapsed_ms,
                tokens_per_second: ev.tokens_per_second,
              },
            }));
          } else if (ev.kind === "error") {
            patchAssistant((m) => ({
              content: (m.content ?? "") + `\n\n_⚠ ${ev.message}_`,
            }));
            teardown();
          } else if (ev.kind === "cancelled" || ev.kind === "done") {
            teardown();
          }
        },
      );
      set({ activeStream: { stop: handle.stop, unlisten: handle.unlisten } });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      logger.error("private chat stream failed", e);
      patchAssistant(() => ({ content: `_⚠ ${detail}_` }));
      teardown();
    }
  },

  cancel: async () => {
    const stream = get().activeStream;
    if (!stream) return;
    try {
      stream.unlisten();
    } catch {
      /* ignore */
    }
    try {
      await stream.stop();
    } catch (e) {
      logger.error("private chat cancel failed", e);
    }
    set({
      activeStream: null,
      isStreaming: false,
      streamingMessageId: null,
    });
  },

  wipe: () => {
    const stream = get().activeStream;
    if (stream) {
      try {
        stream.unlisten();
      } catch {
        /* ignore */
      }
      // Fire the backend cancel without awaiting — close should feel
      // instant. The Rust side cleans up its registry entry regardless.
      void stream.stop().catch(() => {});
    }
    set({
      open: false,
      messages: [],
      isStreaming: false,
      activeStream: null,
      streamingMessageId: null,
      params: {},
      personaId: null,
      toneId: null,
      additionalSystemPrompt: "",
      // model + paramsOpen are preserved across opens — pure UI prefs, not
      // chat content. Everything else (transcript, attachments, params,
      // persona/tone/prompt the user picked) is dropped.
    });
  },
}));
