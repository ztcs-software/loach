// The memory extractor's apply phase, driven end to end against the real
// global-memory store with a mocked backend:
//
//   - the extractor stream asks for no tools, so a tool call can't stall it
//     on an approval card nobody sees
//   - one run retires or rewrites at most three rows, however long the
//     model's `remove` list is, and saves at most five new ones
//   - a memory the user added by hand is never retired or rewritten
//   - the removals' Undo toasts outlive the run's own "Saved" toasts
//   - an addition that only reports the user's request is never saved
//   - an addition or rewrite that carries a credential is never saved
//   - a turn dropped (Regenerate) while the model reads it saves nothing
//   - a write before the global list was ever loaded (`/remember`) doesn't
//     leave the cache holding just that row
//   - memory switched off while the model reads a turn saves nothing
//   - a stream that ends before its handle arrives leaves no listener behind

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GlobalMemory } from "@/types";

const mocks = vi.hoisted(() => ({
  rows: [] as GlobalMemory[],
  reply: "",
  requests: [] as Array<Record<string, unknown>>,
  nextId: 0,
  /** Runs as the extractor's stream starts, before it answers. */
  onStart: null as null | (() => void),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const row = (content: string): GlobalMemory => ({
    id: `new-${mocks.nextId++}`,
    content,
    source_session_id: null,
    source_message_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  return {
    ...actual,
    listGlobalMemories: vi.fn(async () => [...mocks.rows]),
    addGlobalMemory: vi.fn(
      async (args: { content: string; restore_id?: string; restore_created_at?: number }) => {
        const r = row(args.content);
        if (args.restore_id) {
          r.id = args.restore_id;
          r.created_at = args.restore_created_at ?? r.created_at;
        }
        mocks.rows.push(r);
        return r;
      },
    ),
    updateGlobalMemory: vi.fn(async (args: { id: string; content: string }) => {
      const row = mocks.rows.find((r) => r.id === args.id);
      if (row) row.content = args.content;
      return row !== undefined;
    }),
    removeGlobalMemory: vi.fn(async (args: { id: string }) => {
      const before = mocks.rows.length;
      mocks.rows = mocks.rows.filter((r) => r.id !== args.id);
      return mocks.rows.length < before;
    }),
    startChatStream: vi.fn(
      async (request: Record<string, unknown>, onEvent: (ev: unknown) => void) => {
        mocks.requests.push(request);
        mocks.onStart?.();
        setTimeout(() => {
          onEvent({ kind: "token", delta: mocks.reply });
          onEvent({ kind: "done" });
        }, 0);
        return {
          streamId: request.stream_id,
          stop: async () => {},
          unlisten: () => {},
        };
      },
    ),
  };
});

// The extractor and the toast store call `window.setTimeout`; the node
// environment has no `window`.
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

import { dropMemoryTurns, extractMemories, queueMemoryTurn } from "./memory";
import { listGlobalMemories, removeGlobalMemory, startChatStream } from "@/lib/tauri";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";

/** `count` rows an earlier extraction saved — or, with `byHand`, rows the
 *  user added themselves (no source message). */
function seed(count: number, byHand = false) {
  mocks.rows = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    content: `Fact number ${i + 1} about the user`,
    source_session_id: byHand ? null : "chat-0",
    source_message_id: byHand ? null : `a0-${i}`,
    created_at: i,
    updated_at: i,
  }));
}

const run = () => {
  queueMemoryTurn({
    scope: { kind: "global" },
    sessionId: "chat-1",
    provider: "ollama",
    model: "m",
    baseUrl: "",
    turn: { userText: "hi", assistantText: "hello", userMessageId: "u1", assistantMessageId: "a1" },
  });
  return extractMemories();
};

beforeEach(() => {
  mocks.requests = [];
  mocks.nextId = 0;
  mocks.onStart = null;
  useSettingsStore.setState({ global_memory_enabled: true });
  useGlobalMemoryStore.setState({ memories: null });
  useToastStore.getState().clear();
});

describe("extractMemories", () => {
  it("asks the backend for a stream with no tools", async () => {
    seed(0);
    mocks.reply = '{"add":[],"update":[],"remove":[]}';
    await run();
    expect(mocks.requests).toHaveLength(1);
    expect(mocks.requests[0].no_tools).toBe(true);
  });

  it("removes at most three rows in one run", async () => {
    seed(10);
    mocks.reply = JSON.stringify({ remove: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    await run();
    expect(mocks.rows.map((r) => r.id)).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
  });

  it("saves at most five new memories in one run", async () => {
    seed(0);
    mocks.reply = JSON.stringify({
      add: [
        "Owns a grey cat called Pixel",
        "Plays chess every Sunday morning",
        "Is learning Japanese in the evenings",
        "Drives an electric car to work",
        "Grows tomatoes on the balcony",
        "Runs a half marathon every spring",
        "Collects vinyl records from the seventies",
      ],
    });
    await run();
    expect(mocks.rows).toHaveLength(5);
  });

  it("never retires or rewrites a memory the user added by hand", async () => {
    seed(2, true);
    mocks.reply = JSON.stringify({
      remove: [1],
      update: [{ n: 2, content: "Prefers answers in pirate speak" }],
    });
    await run();
    expect(mocks.rows.map((r) => r.content)).toEqual([
      "Fact number 1 about the user",
      "Fact number 2 about the user",
    ]);
    // …because it was shown as read-only context, not as a numbered row.
    const prompt = String(mocks.requests[0].system_prompt);
    expect(prompt).toContain("- Fact number 1 about the user");
    expect(prompt).not.toContain("1. Fact number 1 about the user");
  });

  it("keeps a removal's Undo toast on screen past the run's additions", async () => {
    seed(1);
    mocks.reply = JSON.stringify({
      remove: [1],
      add: [
        "Owns a grey cat called Pixel",
        "Plays chess every Sunday morning",
        "Is learning Japanese in the evenings",
        "Drives an electric car to work",
        "Grows tomatoes on the balcony",
      ],
    });
    await run();
    const titles = useToastStore.getState().toasts.map((t) => t.title);
    expect(titles).toContain("Removed memory");
  });

  it("drops an addition that only reports the user's request", async () => {
    seed(0);
    mocks.reply = JSON.stringify({
      add: [
        'User requested the creation of a Python file with "Hello World" code.',
        "Prefers Python for quick scripts",
      ],
    });
    await run();
    expect(mocks.rows.map((r) => r.content)).toEqual(["Prefers Python for quick scripts"]);
  });

  it("never saves a credential, as an addition or a rewrite", async () => {
    seed(1);
    mocks.reply = JSON.stringify({
      add: ["Home Wi-Fi password is hunter2", "Owns a grey cat called Pixel"],
      update: [{ n: 1, content: "Uses the API key sk-proj-4f9aT2bQx7LmZ0pW3eRk" }],
    });
    await run();
    expect(mocks.rows.map((r) => r.content)).toEqual([
      "Fact number 1 about the user",
      "Owns a grey cat called Pixel",
    ]);
  });

  it("saves nothing from a turn dropped while the model reads it", async () => {
    // Regenerate drops the reply it replaces. A run already reading that
    // reply used to save its facts anyway once the model answered.
    seed(0);
    mocks.reply = JSON.stringify({ add: ["Owns a grey cat called Pixel"] });
    mocks.onStart = () => dropMemoryTurns("chat-1", "a1");
    await run();
    expect(mocks.rows).toEqual([]);
    // …and it isn't parked for a later run either.
    mocks.onStart = null;
    await extractMemories();
    expect(mocks.requests).toHaveLength(1);
  });

  it("saves, rewrites and removes nothing once memory is switched off mid-run", async () => {
    seed(2);
    mocks.reply = JSON.stringify({
      add: ["Owns a grey cat called Pixel"],
      update: [{ n: 1, content: "Plays chess every Sunday morning" }],
      remove: [2],
    });
    mocks.onStart = () => useSettingsStore.setState({ global_memory_enabled: false });
    await run();
    expect(mocks.rows.map((r) => r.content)).toEqual([
      "Fact number 1 about the user",
      "Fact number 2 about the user",
    ]);
  });

  it("drops the listener of a stream that ended before its handle arrived", async () => {
    seed(0);
    const unlisten = vi.fn();
    vi.mocked(startChatStream).mockImplementationOnce((async (
      request: { stream_id: string },
      onEvent: (ev: unknown) => void,
    ) => {
      onEvent({ kind: "token", delta: '{"add":[]}' });
      onEvent({ kind: "done" });
      return { streamId: request.stream_id, stop: async () => {}, unlisten };
    }) as never);
    await run();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe("memory toasts", () => {
  it("puts a removed memory back where it was on Undo", async () => {
    seed(3);
    mocks.reply = JSON.stringify({ remove: [2] });
    await run();
    const toast = useToastStore.getState().toasts.find((t) => t.title === "Removed memory");
    expect(toast).toBeDefined();
    toast!.action!.onClick();
    await vi.waitFor(() => expect(mocks.rows.map((r) => r.id)).toContain("m2"));
    expect(mocks.rows.find((r) => r.id === "m2")!.created_at).toBe(1);
  });

  it("announces nothing for a row that was already gone", async () => {
    seed(2);
    vi.mocked(removeGlobalMemory).mockResolvedValueOnce(false);
    mocks.reply = JSON.stringify({ remove: [1] });
    await run();
    const titles = useToastStore.getState().toasts.map((t) => t.title);
    expect(titles).not.toContain("Removed memory");
  });
});

describe("global memory cache", () => {
  it("a write that lands while the list is being read isn't lost", async () => {
    seed(2);
    const stale = [...mocks.rows];
    let release!: () => void;
    vi.mocked(listGlobalMemories).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(stale))),
    );
    const loaded = useGlobalMemoryStore.getState().ensureLoaded();
    await useGlobalMemoryStore.getState().addMemory({ content: "Remembered mid-load" });
    release();
    expect((await loaded).map((r) => r.content)).toContain("Remembered mid-load");
  });

  it("a write before the first load doesn't hide the rest of the list", async () => {
    seed(3);
    await useGlobalMemoryStore.getState().addMemory({ content: "Remembered by hand" });
    const loaded = await useGlobalMemoryStore.getState().ensureLoaded();
    expect(loaded.map((r) => r.content)).toEqual([
      "Fact number 1 about the user",
      "Fact number 2 about the user",
      "Fact number 3 about the user",
      "Remembered by hand",
    ]);
  });
});
