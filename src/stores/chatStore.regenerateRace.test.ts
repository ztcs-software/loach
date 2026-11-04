// Coverage for the "one in-flight task per chat" cap across the async gap
// inside `regenerateLast`.
//
// Regenerate deletes the old reply, then awaits the request build — which
// resolves the chat's Library sources, and a search can take seconds while an
// embedding model loads. Nothing in `runningTask` / `queue` mentions the chat
// during that wait, so a send landing in it used to dispatch a second task
// for the same chat, and the regenerated reply arrived after the follow-up's.
//
// `ragSearch` is the mocked await we park on: the chat links one large
// Library item, so the send path searches it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryItemMeta, Message } from "@/types";

const mocks = vi.hoisted(() => ({
  gate: { release: null as null | (() => void), searches: 0 },
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  let seq = 100;
  return {
    ...actual,
    listMessages: vi.fn(() => Promise.resolve([] as Message[])),
    deleteMessage: vi.fn(() => Promise.resolve()),
    updateMessage: vi.fn(() => Promise.resolve()),
    appendMessage: vi.fn((args: { session_id: string; role: string; content: string }) =>
      Promise.resolve({ ...msg(`m-${++seq}`, args.role, args.content), session_id: args.session_id }),
    ),
    libraryListSources: vi.fn(async () => []),
    // The first search (the regenerate's) parks until the test releases it.
    ragSearch: vi.fn(() => {
      mocks.gate.searches += 1;
      const res = { hits: [], method: "keyword", warning: null };
      if (mocks.gate.searches === 1) return new Promise((r) => (mocks.gate.release = () => r(res)));
      return Promise.resolve(res);
    }),
    // Connect but never finish: the task stays running.
    startChatStream: vi.fn((request: { stream_id: string }) =>
      Promise.resolve({ streamId: request.stream_id, stop: () => Promise.resolve(), unlisten: () => undefined }),
    ),
  };
});

import { isPreparingSend, useChatStore, __testing } from "./chatStore";
import { useLibraryStore } from "./libraryStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function msg(id: string, role: string, content: string): Message {
  return {
    id,
    session_id: "sess-A",
    role,
    content,
    thinking: null,
    attachments_json: null,
    metrics_json: null,
    tool_calls_json: null,
    compacted_at: null,
    import_group: null,
    import_hidden: false,
    pinned_at: null,
    created_at: 1,
  } as unknown as Message;
}

const big = {
  id: "b",
  kind: "text",
  title: "Big",
  mime: "text/markdown",
  media: "text",
  size: 1,
  chars: 100_000,
  preview: "",
  url: null,
  fetched_at: null,
  content_hash: "b",
  truncated: false,
  chunks: 1,
  embedded: 0,
  created_at: 1,
  updated_at: 1,
} satisfies LibraryItemMeta;

beforeEach(() => {
  mocks.gate.release = null;
  mocks.gate.searches = 0;
  __testing.resetForTests();
  useLibraryStore.setState({
    hydrated: true,
    items: [big],
    datasets: [],
    sources: {
      "session:sess-A": [
        { id: "l1", owner_id: "sess-A", item_id: "b", dataset_id: null, enabled: true, position: 0, created_at: 0 },
      ],
    },
  });
  useChatStore.setState({
    sessions: [
      {
        id: "sess-A",
        title: "A",
        provider: "ollama",
        model: "test-model",
        system_prompt: null,
        params_json: null,
        space_id: null,
        pinned_at: null,
        archived_at: null,
        forked_from_session_id: null,
        label: null,
        folder_id: null,
        workspace_root: null,
        retrieval_mode: null,
        created_at: 0,
        updated_at: 0,
      },
    ],
    activeSessionId: "sess-A",
    messages: { "sess-A": [msg("u1", "user", "question"), msg("a1", "assistant", "old answer")] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("regenerateLast one-task-per-chat cap", () => {
  it("refuses a send that lands while the regenerate resolves its sources", async () => {
    const regen = get().regenerateLast("sess-A");
    await tick();
    await tick();
    // Parked in the search: the chat isn't running or queued yet, but it is
    // claimed — which is what the composer checks to keep its draft.
    expect(get().runningTask).toBeNull();
    expect(get().queue).toHaveLength(0);
    expect(isPreparingSend("sess-A")).toBe(true);

    await get().sendUserMessage("follow-up", []);

    mocks.gate.release!();
    await regen;
    await tick();

    const tasks = [get().runningTask, ...get().queue].filter((t) => t?.sessionId === "sess-A");
    expect(tasks).toHaveLength(1);
    expect(get().messages["sess-A"].filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "question",
    ]);
    expect(isPreparingSend("sess-A")).toBe(false);
  });
});
