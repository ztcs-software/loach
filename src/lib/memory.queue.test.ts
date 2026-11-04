// Memory-extraction turns waiting in the queue used to live in memory only,
// so quitting before a reply ended with the model idle lost them. The queue
// is now mirrored into localStorage — as references, never the chat's words
// — and rebuilt from the database on the next launch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session, Space } from "@/types";

const mocks = vi.hoisted(() => ({
  transcripts: {} as Record<string, Array<{ id: string; content: string }>>,
  prompts: [] as string[],
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    listMessages: vi.fn(async (id: string) => (mocks.transcripts[id] ?? []) as Message[]),
    listGlobalMemories: vi.fn(async () => []),
    listSpaceMemories: vi.fn(async () => []),
    startChatStream: vi.fn(
      async (request: { stream_id: string; messages: Array<{ content: string }> }, onEvent: (ev: unknown) => void) => {
        mocks.prompts.push(request.messages[0]!.content);
        setTimeout(() => {
          onEvent({ kind: "token", delta: '{"add":[]}' });
          onEvent({ kind: "done" });
        }, 0);
        return { streamId: request.stream_id, stop: async () => {}, unlisten: () => {} };
      },
    ),
  };
});

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
});
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

const chats = new Set(["chat-1", "chat-2", "chat-3"]);
const findSession = (id: string) =>
  chats.has(id) ? ({ id, provider: "ollama", model: "m" } as Session) : undefined;

/** A fresh copy of the app's modules, as after a restart. */
async function launch() {
  vi.resetModules();
  const memory = await import("./memory");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const { useSpaceStore } = await import("@/stores/spaceStore");
  useSettingsStore.setState({ global_memory_enabled: true });
  useSpaceStore.setState({
    spaces: [
      { id: "on", memory_enabled: true } as Space,
      { id: "off", memory_enabled: false } as Space,
    ],
  });
  return memory;
}

function queue(
  memory: typeof import("./memory"),
  sessionId: string,
  n: number,
  scope: import("./memory").MemoryScope = { kind: "global" },
) {
  memory.queueMemoryTurn({
    scope,
    sessionId,
    provider: "ollama",
    model: "m",
    baseUrl: "",
    turn: {
      userText: `question ${n}`,
      assistantText: `answer ${n}`,
      userMessageId: `u${n}`,
      assistantMessageId: `a${n}`,
    },
  });
}

beforeEach(() => {
  saved.clear();
  mocks.prompts = [];
  mocks.transcripts = {
    "chat-1": [
      { id: "u1", content: "I live in Gdańsk" },
      { id: "a1", content: "Nice city." },
    ],
    "chat-2": [
      { id: "u2", content: "I have a dog" },
      { id: "a2", content: "Dogs are great." },
    ],
    "chat-3": [{ id: "u3", content: "I play chess" }],
  };
});

describe("the memory queue across a restart", () => {
  it("keeps a waiting turn, storing only references to it", async () => {
    const before = await launch();
    queue(before, "chat-1", 1, { kind: "space", spaceId: "on" });
    const stored = saved.get("loach:memory-queue")!;
    expect(JSON.parse(stored)).toEqual([
      { sessionId: "chat-1", scope: { kind: "space", spaceId: "on" }, userMessageId: "u1", assistantMessageId: "a1" },
    ]);
    expect(stored).not.toContain("question");

    const after = await launch();
    await after.restoreMemoryTurns(findSession);
    await after.extractMemories();
    expect(mocks.prompts).toHaveLength(1);
    expect(mocks.prompts[0]).toContain("I live in Gdańsk");
    expect(mocks.prompts[0]).toContain("Nice city.");
    // Read, so no longer waiting.
    expect(saved.has("loach:memory-queue")).toBe(false);
  });

  it("drops turns whose chat or messages are gone, or whose memory is off now", async () => {
    const before = await launch();
    queue(before, "chat-1", 1);
    queue(before, "chat-gone", 4);
    queue(before, "chat-3", 3); // its reply was deleted
    queue(before, "chat-2", 2, { kind: "space", spaceId: "off" });

    const after = await launch();
    await after.restoreMemoryTurns(findSession);
    expect(JSON.parse(saved.get("loach:memory-queue")!)).toEqual([
      { sessionId: "chat-1", scope: { kind: "global" }, userMessageId: "u1", assistantMessageId: "a1" },
    ]);
    await after.extractMemories();
    expect(mocks.prompts).toHaveLength(1);
    expect(mocks.prompts[0]).toContain("I live in Gdańsk");
  });

  it("forgets turns dropped by Regenerate or by deleting their chat", async () => {
    const memory = await launch();
    queue(memory, "chat-1", 1);
    queue(memory, "chat-2", 2);
    memory.dropMemoryTurns("chat-1", "a1");
    expect(JSON.parse(saved.get("loach:memory-queue")!)).toMatchObject([{ sessionId: "chat-2" }]);
    memory.dropMemoryTurns("chat-2");
    expect(saved.has("loach:memory-queue")).toBe(false);
  });
});
