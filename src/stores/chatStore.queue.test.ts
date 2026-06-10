// Coverage for the waiting-queue lifecycle around `startTask`:
//
//   - FIFO promotion: when the running task finishes, the queue head (from
//     ANY session) starts next — `done` → `finishRunning` → `promoteQueueHead`.
//   - Cancelling the RUNNING session stops its stream and promotes the next
//     waiter instead of stranding the queue.
//   - Cancelling a WAITING session evicts it without disturbing the runner.
//   - `promoteSession` jumps a waiter to the head (cancelling the current
//     runner) or starts it directly when nothing is running.
//
// Same harness as `chatStore.streamRace.test.ts`: `startChatStream` is the
// only mocked wrapper, we park each connect until the test resolves it, and
// we drive terminal events by hand. Queue entries are seeded with
// `setState({ queue })` — `sendUserMessage` builds them from live provider
// settings, which is exactly the coupling these unit tests avoid.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) =>
  clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const set = ((p: unknown) =>
  useChatStore.setState(p as never)) as Parameters<typeof __testing.startTask>[2];
// Drain pending microtasks + 0-delay timers — enough for `promoteQueueHead`'s
// queueMicrotask, the promoted task's `appendMessage` await, and its
// `startChatStream` call to all land.
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

/** Boilerplate: get task A running with its stream connected + installed. */
async function startRunning(suffix = "A") {
  const p = __testing.startTask(makeTask(`sess-${suffix}`, suffix), get, set);
  await tick();
  mocks.streams[mocks.streams.length - 1].resolve();
  await tick();
  await p;
  expect(get().runningTask?.id).toBe(`task-${suffix}`);
  expect(get().activeStream).not.toBeNull();
}

beforeEach(() => {
  mocks.streams.length = 0;
  useChatStore.setState({
    sessions: [],
    activeSessionId: "sess-A",
    messages: {},
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("chat queue promotion", () => {
  it("starts queued tasks in FIFO order as each one finishes", async () => {
    await startRunning("A");
    useChatStore.setState({
      queue: [makeTask("sess-B", "B"), makeTask("sess-C", "C")],
    } as never);

    // A finishes → B (the head) must start; C stays parked.
    mocks.streams[0].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask?.id).toBe("task-B");
    expect(get().queue.map((t) => t.id)).toEqual(["task-C"]);
    expect(mocks.streams).toHaveLength(2);

    mocks.streams[1].resolve();
    await tick();
    mocks.streams[1].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask?.id).toBe("task-C");

    mocks.streams[2].resolve();
    await tick();
    mocks.streams[2].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask).toBeNull();
    expect(get().queue).toEqual([]);
    expect(get().isStreaming).toBe(false);
  });

  it("promotes the next waiter when the running session is cancelled", async () => {
    await startRunning("A");
    useChatStore.setState({ queue: [makeTask("sess-B", "B")] } as never);

    await get().cancelForSession("sess-A");
    expect(mocks.streams[0].stopped).toBe(true);

    await tick();
    expect(get().runningTask?.id).toBe("task-B");
    expect(get().queue).toEqual([]);

    // Drive B to completion so module-level dispatch state is clean.
    mocks.streams[1].resolve();
    await tick();
    mocks.streams[1].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask).toBeNull();
  });

  it("evicts a waiting task without disturbing the runner", async () => {
    await startRunning("A");
    useChatStore.setState({ queue: [makeTask("sess-B", "B")] } as never);

    await get().cancelForSession("sess-B");
    await tick();

    // B is gone, A streams on, and no stream was ever opened for B.
    expect(get().queue).toEqual([]);
    expect(get().runningTask?.id).toBe("task-A");
    expect(get().isStreaming).toBe(true);
    expect(mocks.streams).toHaveLength(1);
    expect(mocks.streams[0].stopped).toBe(false);

    mocks.streams[0].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask).toBeNull();
  });

  it("promoteSession moves a waiter to the head and cancels the runner", async () => {
    await startRunning("A");
    useChatStore.setState({
      queue: [makeTask("sess-B", "B"), makeTask("sess-C", "C")],
    } as never);

    // "Generate now" on C: C jumps the line, A is cancelled, B keeps waiting.
    await get().promoteSession("sess-C");
    expect(mocks.streams[0].stopped).toBe(true);

    await tick();
    expect(get().runningTask?.id).toBe("task-C");
    expect(get().queue.map((t) => t.id)).toEqual(["task-B"]);

    // …and when C finishes, B is picked up — promotion didn't drop it.
    mocks.streams[1].resolve();
    await tick();
    mocks.streams[1].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask?.id).toBe("task-B");

    mocks.streams[2].resolve();
    await tick();
    mocks.streams[2].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask).toBeNull();
    expect(get().queue).toEqual([]);
  });

  it("promoteSession starts a waiter directly when nothing is running", async () => {
    useChatStore.setState({ queue: [makeTask("sess-B", "B")] } as never);

    // `promoteSession` awaits the direct start, which parks at the connect —
    // resolve it mid-flight rather than awaiting up front.
    const p = get().promoteSession("sess-B");
    await tick();
    expect(mocks.streams).toHaveLength(1);
    expect(get().runningTask?.id).toBe("task-B");
    expect(get().queue).toEqual([]);

    mocks.streams[0].resolve();
    await tick();
    await p;
    mocks.streams[0].onEvent({ kind: "done" });
    await tick();
    expect(get().runningTask).toBeNull();
    expect(get().isStreaming).toBe(false);
  });
});
