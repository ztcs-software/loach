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
//   - a write before the global list was ever loaded (`/remember`) doesn't
//     leave the cache holding just that row

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GlobalMemory } from "@/types";

const mocks = vi.hoisted(() => ({
  rows: [] as GlobalMemory[],
  reply: "",
  requests: [] as Array<Record<string, unknown>>,
  nextId: 0,
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

import { extractMemories } from "./memory";
import { listGlobalMemories, removeGlobalMemory } from "@/lib/tauri";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
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

const run = () =>
  extractMemories({
    scope: { kind: "global" },
    sessionId: "chat-1",
    provider: "ollama",
    model: "m",
    baseUrl: "",
    turn: { userText: "hi", assistantText: "hello", assistantMessageId: "a1" },
  });

beforeEach(() => {
  mocks.requests = [];
  mocks.nextId = 0;
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
