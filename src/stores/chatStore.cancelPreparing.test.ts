// `cancelForSession` against work that is in neither `runningTask` nor
// `queue`: a send or regenerate still building its request, and a task
// between leaving the queue and `startTask` setting `runningTask`.
//
// Archive, delete and /clear all stop a chat through `cancelForSession`, which
// looked only at the runner and the queue — so work in those gaps went on to
// stream into the chat they had just put away.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "@/types";

const mocks = vi.hoisted(() => ({
  /** Role whose next `appendMessage` parks until `release` (null: none). */
  park: null as null | "user" | "assistant",
  /** Park the next `deleteMessage` (Regenerate's first await). */
  parkDelete: false,
  release: null as null | (() => void),
  deleted: [] as string[],
  /** Id of the last assistant placeholder written. */
  placeholder: null as null | string,
  connects: 0,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  let seq = 0;
  const gate = <T>(value: T): Promise<T> =>
    new Promise((resolve) => (mocks.release = () => resolve(value)));
  return {
    ...actual,
    appendMessage: vi.fn((args: { session_id: string; role: "user" | "assistant"; content: string }) => {
      const msg = { ...message(`m-${++seq}`, args.role, args.content), session_id: args.session_id };
      if (args.role === "assistant") mocks.placeholder = msg.id;
      if (mocks.park === args.role) {
        mocks.park = null;
        return gate(msg);
      }
      return Promise.resolve(msg);
    }),
    deleteMessage: vi.fn((id: string) => {
      mocks.deleted.push(id);
      if (mocks.parkDelete) {
        mocks.parkDelete = false;
        return gate(undefined);
      }
      return Promise.resolve();
    }),
    // Connect but never finish.
    startChatStream: vi.fn((request: { stream_id: string }) => {
      mocks.connects += 1;
      return Promise.resolve({ streamId: request.stream_id, stop: () => Promise.resolve(), unlisten: () => undefined });
    }),
  };
});

import { isPreparingSend, useChatStore, __testing } from "./chatStore";
import { useLibraryStore } from "./libraryStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function message(id: string, role: string, content: string): Message {
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

beforeEach(() => {
  mocks.park = null;
  mocks.parkDelete = false;
  mocks.release = null;
  mocks.deleted = [];
  mocks.placeholder = null;
  mocks.connects = 0;
  __testing.resetForTests();
  useLibraryStore.setState({ hydrated: true, error: null, items: [], datasets: [], sources: {} });
  useChatStore.setState({
    sessions: [
      {
        id: "sess-A",
        title: "A",
        provider: "openai",
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
    messages: { "sess-A": [message("u1", "user", "question"), message("a1", "assistant", "old answer")] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

function nothingDispatched() {
  expect(mocks.connects).toBe(0);
  expect(get().runningTask).toBeNull();
  expect(get().queue).toEqual([]);
  expect(get().isStreaming).toBe(false);
}

describe("cancelForSession on work not yet running or queued", () => {
  it("stops a send still building its request", async () => {
    mocks.park = "user";
    const send = get().sendUserMessage("follow-up", []);
    await tick();
    expect(isPreparingSend("sess-A")).toBe(true);

    await get().cancelForSession("sess-A");
    mocks.release!();
    await send;
    await tick();

    nothingDispatched();
    // The question stays, as it does for a cancelled waiter.
    expect(get().messages["sess-A"].map((m) => m.content)).toContain("follow-up");
    expect(isPreparingSend("sess-A")).toBe(false);
  });

  it("stops a regenerate still building its request", async () => {
    mocks.parkDelete = true;
    const regen = get().regenerateLast("sess-A");
    await tick();

    await get().cancelForSession("sess-A");
    mocks.release!();
    await regen;
    await tick();

    nothingDispatched();
  });

  it("stops a task between the queue and the stream, and drops its placeholder", async () => {
    // The send has dispatched; `startTask` is writing the reply's placeholder.
    mocks.park = "assistant";
    const send = get().sendUserMessage("follow-up", []);
    await vi.waitFor(() => expect(mocks.release).not.toBeNull());
    expect(get().runningTask).toBeNull();

    await get().cancelForSession("sess-A");
    mocks.release!();
    await send;
    await tick();

    nothingDispatched();
    expect(mocks.placeholder).not.toBeNull();
    expect(mocks.deleted).toContain(mocks.placeholder);
    expect(get().messages["sess-A"].map((m) => m.id)).not.toContain(mocks.placeholder);
  });

  it("leaves the chat's next send alone", async () => {
    await get().cancelForSession("sess-A");
    await get().sendUserMessage("after the stop", []);
    await tick();
    expect(mocks.connects).toBe(1);
    expect(get().runningTask?.sessionId).toBe("sess-A");
  });
});
