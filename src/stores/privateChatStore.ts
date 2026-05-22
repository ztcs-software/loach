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
  /** Ollama model id picked for this private session. Lives in memory only
   *  for the lifetime of the overlay — closing the overlay wipes it along
   *  with everything else. Reopens start blank and re-pick a default in
   *  `ModelPicker.refresh`. */
  model: string;
  params: Partial<GenerationParams>;
  /** Whether the right-side parameters sidebar is visible. Wiped on close
   *  along with the rest of the state — reopening starts with the sidebar
   *  collapsed regardless of what the user had last time. */
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

    // Apply the global Low-VRAM pin (Settings → Features) when the user
    // hasn't set anything in the per-chat panel. Per-chat override wins —
    // toggling Low VRAM off in the Private Chat sidebar stores `undefined`,
    // so the only ambiguity is "untouched", which is when the global
    // default should kick in. Ollama is the only provider Private Chat
    // talks to, so no provider gate is needed here.
    const params =
      state.params.low_vram === undefined && settings.low_vram_global
        ? { ...state.params, low_vram: true }
        : state.params;

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
          params,
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
    // Hydrogen-bomb wipe: every field listed in `PrivateChatState` resets
    // to its initial value. No "UI prefs survive" carve-outs — even the
    // picked model and the sidebar-open flag are erased so a reopen
    // betrays nothing about the prior session (not even which model the
    // user was talking to). `ModelPicker` re-derives a default the next
    // time the overlay opens.
    //
    // Caveat — the "wipe" boundary is GC, not zero-on-free. JS strings are
    // immutable, so we can drop the references but we can't overwrite the
    // base64 attachment bytes (or message contents) sitting in the V8 /
    // WebView2 heap. Once the runtime garbage-collects them the slots are
    // reusable, but until then a process-memory dump could still find the
    // strings. Acceptable for the documented threat model (single-user
    // desktop app, no remote attacker, no on-disk persistence) — if zero-
    // on-free becomes a requirement, attachments would need to be carried
    // as `Uint8Array` end-to-end so we could `fill(0)` them here.
    set({
      open: false,
      messages: [],
      isStreaming: false,
      activeStream: null,
      streamingMessageId: null,
      model: "",
      params: {},
      paramsOpen: false,
      personaId: null,
      toneId: null,
      additionalSystemPrompt: "",
    });
  },
}));
