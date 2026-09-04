// Regression coverage: a reply's metrics footer vanished the moment its
// stream finished. `finishRunning` drops the `streamingByMessage` entry on
// completion and relies on the message's `metrics_json` from there on — but
// it only persisted that JSON to SQLite, never onto the cached in-memory
// message, and a cached transcript isn't re-read until restart. So every
// reply streamed since launch showed no tok/s line until the app restarted.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the (hoisted) `vi.mock` factory and the tests share one array.
const mocks = vi.hoisted(() => {
  interface FakeStream {
    onEvent: (ev: unknown) => void;
    resolve: () => void;
  }
  const streams: FakeStream[] = [];
  return { streams };
});

// Override ONLY `startChatStream`. Every other `@/lib/tauri` wrapper already
// returns a no-backend fallback when `isTauri` is false (which it is under
// Node), so appendMessage/updateMessage resolve to sane mock values.
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    startChatStream: vi.fn(
      (request: { stream_id: string }, onEvent: (ev: unknown) => void) => {
        const entry = { onEvent } as (typeof mocks.streams)[number];
        const promise = new Promise((res) => {
          entry.resolve = () =>
            res({
              streamId: request.stream_id,
              stop: () => Promise.resolve(),
              unlisten: () => {},
            });
        });
        mocks.streams.push(entry);
        return promise;
      },
    ),
  };
});

import { useChatStore, __testing } from "./chatStore";

// Node has no requestAnimationFrame; the rAF-batched flush scheduler needs it.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) =>
  clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const set = ((p: unknown) =>
  useChatStore.setState(p as never)) as Parameters<typeof __testing.startTask>[2];
// Drain pending microtasks + 0-delay timers.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeTask(sessionId: string) {
  return {
    id: "task-A",
    sessionId,
    userMsgId: "user-A",
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
  __testing.resetForTests();
  useChatStore.setState({
    sessions: [],
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

describe("metrics survive stream completion", () => {
  it("writes the final metrics onto the in-memory message when the stream finishes", async () => {
    const p = __testing.startTask(makeTask("sess-A"), get, set);
    await tick(); // appendMessage resolves, parked at connect
    mocks.streams[0].resolve();
    await tick();
    const msgId = lastMsg("sess-A").id;

    const metrics = { tokens: 57, elapsed_ms: 790, tokens_per_second: 102.8 };
    mocks.streams[0].onEvent({ kind: "token", delta: "Hi!" });
    mocks.streams[0].onEvent({ kind: "metrics", ...metrics });
    mocks.streams[0].onEvent({ kind: "done" });
    await tick();
    await p;

    // The streaming entry is dropped on completion by design, so the bubble
    // has to find the numbers on the message itself.
    expect(get().streamingByMessage).not.toHaveProperty(msgId);
    const msg = lastMsg("sess-A");
    expect(msg.id).toBe(msgId);
    expect(msg.content).toBe("Hi!");
    expect(JSON.parse(msg.metrics_json ?? "null")).toEqual(metrics);
  });
});
