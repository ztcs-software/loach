import { create } from "zustand";
import {
  appendMessage,
  createSession,
  deleteSession,
  getSpaceContext,
  listMessages,
  listSessions,
  makeRequestId,
  ollamaUnloadModel,
  renameSession,
  startChatStream,
  updateMessage,
} from "@/lib/tauri";
import {
  imagesFromAttachments,
  inlineTextAttachments,
} from "@/lib/files";
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

interface ActiveStream {
  stop: () => Promise<void>;
  unlisten: () => void;
}

interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  streamingByMessage: Record<string, MessageMetrics | null>;
  activeStream: ActiveStream | null;
  isStreaming: boolean;

  hydrate: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  newSession: (provider?: ProviderId, model?: string) => Promise<Session>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setSessionModel: (id: string, provider: ProviderId, model: string) => Promise<void>;
  setSessionSystemPrompt: (id: string, prompt: string) => Promise<void>;
  setSessionParams: (id: string, params: GenerationParams) => Promise<void>;

  sendUserMessage: (content: string, attachments: Attachment[]) => Promise<void>;
  cancelStream: () => Promise<void>;
}

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

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  streamingByMessage: {},
  activeStream: null,
  isStreaming: false,

  hydrate: async () => {
    try {
      const sessions = await listSessions();
      set({ sessions });

      // Remove all empty sessions (no messages) on startup, keep at most one.
      const emptySessions: Session[] = [];
      for (const s of sessions) {
        const msgs = await listMessages(s.id);
        set((st) => ({ messages: { ...st.messages, [s.id]: msgs } }));
        if (msgs.length === 0) emptySessions.push(s);
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

  newSession: async (provider, model) => {
    // Remove all existing empty sessions (no messages) before creating a new one.
    const { sessions, messages } = get();
    const emptyIds: string[] = [];
    for (const s of sessions) {
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

    const settings = useSettingsStore.getState();
    const spaceId = useSpaceStore.getState().activeSpaceId;
    const p: ProviderId = provider ?? settings.default_provider;
    const m = model ?? settings.default_model ?? "";
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

  remove: async (id) => {
    await deleteSession(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const messages = { ...s.messages };
      delete messages[id];
      const active =
        s.activeSessionId === id ? sessions[0]?.id ?? null : s.activeSessionId;
      return { sessions, messages, activeSessionId: active };
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

    const inlinedContent = inlineTextAttachments(rawContent, attachments);
    const images = imagesFromAttachments(attachments);
    const attachmentsJson = JSON.stringify(
      attachments.map((a) => ({
        kind: a.kind,
        name: a.name,
        mime: a.mime,
        // Only persist a marker for images to keep DB small.
        data: a.kind === "image" ? `[image:${a.mime}]` : a.data,
      })),
    );

    // 1. Persist user message
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

    // 2. Create empty assistant placeholder
    const assistantMsg = await appendMessage({
      session_id: sessionId,
      role: "assistant",
      content: "",
    });
    set((s) => ({
      messages: {
        ...s.messages,
        [sessionId!]: [...(s.messages[sessionId!] ?? []), assistantMsg],
      },
      streamingByMessage: { ...s.streamingByMessage, [assistantMsg.id]: null },
      isStreaming: true,
    }));

    // 3. Build chat request
    const settings = useSettingsStore.getState();
    const baseUrl =
      session.provider === "ollama"
        ? settings.ollama_base_url
        : settings.openai_base_url;
    const params = readSessionParams(session);
    const history = get().messages[sessionId] ?? [];
    // Drop the just-inserted empty assistant placeholder from the history we send.
    const trimmed = history.filter((m) => m.id !== assistantMsg.id && m.id !== userMsg.id);
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

    const streamId = makeRequestId();
    let buffered = "";
    let metrics: MessageMetrics | null = null;

    try {
      const handle = await startChatStream(
        {
          stream_id: streamId,
          provider: session.provider,
          model: session.model,
          base_url: baseUrl,
          system_prompt: effectiveSystemPrompt,
          messages: chatMessages,
          params,
        },
        (ev) => {
          if (ev.kind === "token") {
            buffered += ev.delta;
            set((s) => ({
              messages: {
                ...s.messages,
                [sessionId!]: (s.messages[sessionId!] ?? []).map((m) =>
                  m.id === assistantMsg.id ? { ...m, content: buffered } : m,
                ),
              },
            }));
          } else if (ev.kind === "metrics") {
            metrics = {
              tokens: ev.tokens,
              elapsed_ms: ev.elapsed_ms,
              tokens_per_second: ev.tokens_per_second,
            };
            set((s) => ({
              streamingByMessage: {
                ...s.streamingByMessage,
                [assistantMsg.id]: metrics,
              },
            }));
          } else if (ev.kind === "error") {
            buffered += `\n\n_⚠ ${ev.message}_`;
            set((s) => ({
              messages: {
                ...s.messages,
                [sessionId!]: (s.messages[sessionId!] ?? []).map((m) =>
                  m.id === assistantMsg.id ? { ...m, content: buffered } : m,
                ),
              },
            }));
          } else if (ev.kind === "done") {
            void updateMessage({
              id: assistantMsg.id,
              content: buffered,
              metrics_json: metrics ? JSON.stringify(metrics) : null,
            }).catch(() => {});
            set((s) => {
              const stream = s.activeStream;
              if (stream) stream.unlisten();
              return {
                activeStream: null,
                isStreaming: false,
              };
            });
          }
        },
      );
      set({
        activeStream: { stop: handle.stop, unlisten: handle.unlisten },
      });
    } catch (e) {
      set({ isStreaming: false, activeStream: null });
      throw e;
    }
  },

  cancelStream: async () => {
    const stream = get().activeStream;
    if (stream) {
      await stream.stop();
      stream.unlisten();
    }
    set({ activeStream: null, isStreaming: false });
  },
}));
