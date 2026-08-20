// Coverage for the "one in-flight task per chat" cap across the async gap
// inside `sendUserMessage`.
//
// The busy check reads `runningTask` / `queue`, but neither reflects this
// send until the dispatch at the very end — several awaits later (history
// hydration, the optional web-fetch step, the message persist, auto-title,
// request build). The composer meanwhile re-enables the moment it
// optimistically clears its draft. So a second Enter landing inside that gap
// used to pass BOTH guards and dispatch a duplicate task, whose history
// snapshot was taken before the first task's reply existed.
//
// `appendMessage` is the mocked await we park on: it sits inside the gap and
// is reached on every send, which makes it a faithful stand-in for whichever
// step happens to be slow in the field (web fetch allows 15 s per URL).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "@/types";

const mocks = vi.hoisted(() => {
  // `userAppends` counts only user turns — `startTask` also appends an
  // assistant placeholder through the same wrapper, and conflating the two
  // makes the assertions unreadable.
  const gate: { release: (() => void) | null; userAppends: number } = {
    release: null,
    userAppends: 0,
  };
  return { gate };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  let seq = 0;
  return {
    ...actual,
    listMessages: vi.fn(() => Promise.resolve([] as Message[])),
    // Park the FIRST call until the test releases it; later calls resolve
    // immediately so a leaked second send would sail through and be visible.
    appendMessage: vi.fn((args: { session_id: string; role: string; content: string }) => {
      const isUserTurn = args.role === "user";
      if (isUserTurn) mocks.gate.userAppends += 1;
      const msg = {
        id: `m-${++seq}`,
        session_id: args.session_id,
        role: args.role,
        content: args.content,
        thinking: null,
        attachments_json: null,
        metrics_json: null,
        tool_calls_json: null,
        compacted_at: null,
        import_group: null,
        import_hidden: false,
        pinned_at: null,
        created_at: seq,
      } as unknown as Message;
      if (isUserTurn && mocks.gate.userAppends === 1) {
        return new Promise((resolve) => {
          mocks.gate.release = () => resolve(msg);
        });
      }
      return Promise.resolve(msg);
    }),
    // Connect successfully but never emit a terminal event: the task stays
    // "running", which is exactly the state the cap is meant to protect.
    startChatStream: vi.fn((request: { stream_id: string }) =>
      Promise.resolve({
        streamId: request.stream_id,
        stop: () => Promise.resolve(),
        unlisten: () => undefined,
      }),
    ),
  };
});

import { useChatStore, __testing } from "./chatStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) =>
  clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.gate.release = null;
  mocks.gate.userAppends = 0;
  __testing.resetForTests();
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
        created_at: 0,
        updated_at: 0,
      },
    ],
    activeSessionId: "sess-A",
    messages: { "sess-A": [] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("sendUserMessage one-task-per-chat cap", () => {
  it("drops a second send that lands before the first is dispatched", async () => {
    const first = get().sendUserMessage("first", []);
    // The first send is now parked inside `appendMessage` — the window in
    // which neither `runningTask` nor `queue` mentions this session.
    await tick();
    expect(get().runningTask).toBeNull();
    expect(get().queue).toHaveLength(0);

    // Second Enter inside that window. Must be refused.
    await get().sendUserMessage("second", []);
    expect(mocks.gate.userAppends).toBe(1);

    mocks.gate.release!();
    await first;
    await tick();

    // Exactly one user turn persisted, and exactly one task dispatched.
    const dispatched =
      (get().runningTask ? 1 : 0) + get().queue.length;
    expect(dispatched).toBe(1);
    expect(
      get()
        .messages["sess-A"]?.filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["first"]);
  });

  it("releases the reservation so the next send still works", async () => {
    const first = get().sendUserMessage("first", []);
    await tick();
    mocks.gate.release!();
    await first;
    await tick();

    // The chat is now genuinely busy (a task is dispatched), so clear that
    // state to isolate the reservation itself.
    useChatStore.setState({ runningTask: null, queue: [] } as never);
    await get().sendUserMessage("second", []);
    await tick();

    expect(mocks.gate.userAppends).toBe(2);
    expect(
      get()
        .messages["sess-A"]?.filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["first", "second"]);
  });
});
