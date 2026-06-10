// Regression coverage for the chat stream connect-window race (finding H7).
//
// `startTask` sets `runningTask` (which enables the Stop button) BEFORE it
// awaits `startChatStream`, but only installs `activeStream` AFTER the await
// resolves. A cancel that lands in that window used to: leak the orphaned
// backend stream, let its late events corrupt the NEXT task's buffer, and —
// on a connect rejection — clobber the successor task's state. The three
// identity guards (`runningTask?.id === task.id`) in the event callback, the
// post-await install, and the catch block close that window.
//
// These can't be reproduced in the browser preview (mock mode has no model to
// send, and its mock stream resolves instantly so the window never opens), so
// we drive `startTask` directly against a controllable `startChatStream` and
// decide exactly when the connect resolves/rejects and when events fire.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the (hoisted) `vi.mock` factory and the tests share one array.
const mocks = vi.hoisted(() => {
  interface FakeStream {
    streamId: string;
    onEvent: (ev: unknown) => void;
    resolve: () => void;
    reject: (e: unknown) => void;
    stopped: boolean;
    unlistened: boolean;
  }
  const streams: FakeStream[] = [];
  return { streams };
});

// Override ONLY `startChatStream`. Every other `@/lib/tauri` wrapper already
// returns a no-backend fallback when `isTauri` is false (which it is under
// Node), so appendMessage/updateMessage/etc. resolve to sane mock values on
// their own.
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    startChatStream: vi.fn(
      (request: { stream_id: string }, onEvent: (ev: unknown) => void) => {
        const entry = {
          streamId: request.stream_id,
          onEvent,
          stopped: false,
          unlistened: false,
        } as (typeof mocks.streams)[number];
        const promise = new Promise((res, rej) => {
          entry.resolve = () =>
            res({
              streamId: entry.streamId,
              stop: async () => {
                entry.stopped = true;
              },
              unlisten: () => {
                entry.unlistened = true;
              },
            });
          entry.reject = rej;
        });
        mocks.streams.push(entry);
        return promise;
      },
    ),
  };
});

import { useChatStore, __testing } from "./chatStore";

// Node has no requestAnimationFrame; the rAF-batched flush scheduler needs it.
// A 0-delay timer suffices — terminal events flush synchronously through
// `finishRunning`, so assertions never depend on a frame actually firing.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) =>
  clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const set = ((p: unknown) =>
  useChatStore.setState(p as never)) as Parameters<typeof __testing.startTask>[2];
// Drain pending microtasks + 0-delay timers.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeTask(sessionId: string, suffix: string) {
  return {
    id: `task-${suffix}`,
    sessionId,
    userMsgId: `user-${suffix}`,
    request: {
      provider: "ollama",
      model: "test-model",
      base_url: "http://localhost:11434",
      system_prompt: null,
      messages: [],
      params: {},
    },
  } as unknown as Parameters<typeof __testing.startTask>[0];
}

function lastMsg(sessionId: string) {
  const list = get().messages[sessionId] ?? [];
  return list[list.length - 1];
}

beforeEach(() => {
  mocks.streams.length = 0;
  useChatStore.setState({
    sessions: [],
    activeSessionId: "sess-A",
    messages: { "sess-A": [], "sess-B": [] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("chat stream connect-window race (H7)", () => {
  it("tears down an orphaned stream cancelled during the connect window", async () => {
    const p = __testing.startTask(makeTask("sess-A", "A"), get, set);
    await tick(); // appendMessage resolves, runningTask set, parked at connect
    expect(get().runningTask?.id).toBe("task-A");
    expect(mocks.streams).toHaveLength(1);

    await get().cancelForSession("sess-A");
    expect(get().runningTask).toBeNull();
    expect(get().activeStream).toBeNull();

    // The connect resolves AFTER the cancel: the orphaned handle must be
    // stopped + unlistened, NOT installed as the active stream.
    mocks.streams[0].resolve();
    await tick();
    await p;

    expect(mocks.streams[0].stopped).toBe(true);
    expect(mocks.streams[0].unlistened).toBe(true);
    expect(get().activeStream).toBeNull();
    expect(get().isStreaming).toBe(false);
  });

  it("drops a cancelled stream's late events instead of corrupting or tearing down its successor", async () => {
    const pA = __testing.startTask(makeTask("sess-A", "A"), get, set);
    await tick();
    await get().cancelForSession("sess-A");
    mocks.streams[0].resolve(); // orphan A torn down
    await tick();
    await pA;
    expect(mocks.streams[0].stopped).toBe(true);

    // Successor B starts and connects.
    const pB = __testing.startTask(makeTask("sess-B", "B"), get, set);
    await tick();
    expect(get().runningTask?.id).toBe("task-B");
    mocks.streams[1].resolve();
    await tick();
    expect(get().activeStream).not.toBeNull();

    // A's late token + done must be ignored (guard 1): not written into B's
    // buffer, and not allowed to tear B down.
    mocks.streams[0].onEvent({ kind: "token", delta: "POISON" });
    mocks.streams[0].onEvent({ kind: "done" });
    expect(get().runningTask?.id).toBe("task-B");
    expect(get().isStreaming).toBe(true);

    // B streams normally to completion.
    mocks.streams[1].onEvent({ kind: "token", delta: "good" });
    mocks.streams[1].onEvent({ kind: "done" });
    await tick();
    await pB;

    expect(lastMsg("sess-B").content).toBe("good");
    expect(lastMsg("sess-B").content).not.toContain("POISON");
    expect(get().runningTask).toBeNull();
  });

  it("does not clobber state when a cancelled task's connect rejects", async () => {
    const p = __testing.startTask(makeTask("sess-A", "A"), get, set);
    await tick();
    await get().cancelForSession("sess-A");
    expect(get().runningTask).toBeNull();

    // The connect fails after the cancel: the catch must bail (guard 3), not
    // overwrite the cancelled (empty) bubble with an error or reset state it
    // no longer owns.
    mocks.streams[0].reject(new Error("connection refused"));
    await tick();
    await p;

    expect(lastMsg("sess-A").content).toBe("");
    expect(get().runningTask).toBeNull();
    expect(get().isStreaming).toBe(false);
  });
});
