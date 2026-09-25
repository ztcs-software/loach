// The memory extractor's apply phase, driven end to end against the real
// global-memory store with a mocked backend:
//
//   - the extractor stream asks for no tools, so a tool call can't stall it
//     on an approval card nobody sees
//   - one run retires or rewrites at most three rows, however long the
//     model's `remove` list is
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
    addGlobalMemory: vi.fn(async (args: { content: string }) => {
      const r = row(args.content);
      mocks.rows.push(r);
      return r;
    }),
    updateGlobalMemory: vi.fn(async () => {}),
    removeGlobalMemory: vi.fn(async (args: { id: string }) => {
      mocks.rows = mocks.rows.filter((r) => r.id !== args.id);
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
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { useToastStore } from "@/stores/toastStore";

function seed(count: number) {
  mocks.rows = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    content: `Fact number ${i + 1} about the user`,
    source_session_id: null,
    source_message_id: null,
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

describe("global memory cache", () => {
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
