// The "Some MCP servers couldn't be reached" notice arrives as its own
// `notice` event and is kept as a record beside the reply. Sent as reply
// text, it was rendered as Markdown, replayed to the model as its own
// words, copied, exported and read by the memory extractor (X1-07).

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
import { NOTICE_TOOL } from "@/lib/notices";

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

describe("a notice stays beside the reply", () => {
  it("is kept as a notice record, out of the reply's text", async () => {
    const p = __testing.startTask(makeTask("sess-A"), get, set);
    await tick();
    mocks.streams[0].resolve();
    await tick();

    const text = "Some MCP servers couldn't be reached: github: HTTP 401. Continuing with the rest.";
    mocks.streams[0].onEvent({ kind: "notice", text });
    mocks.streams[0].onEvent({ kind: "token", delta: "Hi!" });
    mocks.streams[0].onEvent({ kind: "done" });
    await tick();
    await p;

    const msg = lastMsg("sess-A");
    expect(msg.content).toBe("Hi!");
    const records = JSON.parse(msg.tool_calls_json ?? "[]") as Array<{ tool: string; result: string }>;
    expect(records).toEqual([expect.objectContaining({ tool: NOTICE_TOOL, result: text })]);
  });
});
