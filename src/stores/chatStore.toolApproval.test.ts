// Per-call tool approvals (v1.5), driven through the store's stream seam.
//
// The backend emits `tool_call { approval_required: true }` and parks until
// `tool_approval_respond` is invoked; the store has to (1) flag the record
// so the bubble renders the consent card, (2) deliver the user's answer
// keyed by the stream id it was handed at connect time, clearing the flag
// optimistically, (3) settle the record on the eventual `tool_result`
// (including the `denied` outcome), and (4) never persist a record as still
// waiting once the stream is torn down — a reloaded transcript would
// otherwise show a dead prompt.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallRecord } from "@/types";

const mocks = vi.hoisted(() => {
  interface FakeStream {
    streamId: string;
    onEvent: (ev: unknown) => void;
    resolve: () => void;
    stopped: boolean;
    unlistened: boolean;
  }
  const streams: FakeStream[] = [];
  const respond = vi.fn(() => Promise.resolve(true));
  const updates: Array<{ tool_calls_json?: string | null }> = [];
  return { streams, respond, updates };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    toolApprovalRespond: mocks.respond,
    updateMessage: vi.fn(async (args: { tool_calls_json?: string | null }) => {
      mocks.updates.push(args);
      return args;
    }),
    startChatStream: vi.fn(
      (request: { stream_id: string }, onEvent: (ev: unknown) => void) => {
        const entry = {
          streamId: request.stream_id,
          onEvent,
          stopped: false,
          unlistened: false,
        } as (typeof mocks.streams)[number];
        const promise = new Promise((res) => {
          entry.resolve = () =>
            res({
              streamId: entry.streamId,
              stop: () => {
                entry.stopped = true;
                if (!entry.unlistened) entry.onEvent({ kind: "cancelled" });
                return Promise.resolve();
              },
              unlisten: () => {
                entry.unlistened = true;
              },
            });
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

function toolCalls(sessionId: string): ToolCallRecord[] {
  const list = get().messages[sessionId] ?? [];
  const last = list[list.length - 1];
  return last?.tool_calls_json ? (JSON.parse(last.tool_calls_json) as ToolCallRecord[]) : [];
}

const CALL = {
  kind: "tool_call",
  id: "call_0_0",
  server_id: "srv-1",
  server_name: "GitHub",
  tool: "GitHub__create_issue",
  arguments: { title: "x" },
};

async function startConnected() {
  const p = __testing.startTask(makeTask("sess-A", "A"), get, set);
  await tick();
  mocks.streams[0].resolve();
  await tick();
  return p;
}

beforeEach(() => {
  mocks.streams.length = 0;
  mocks.updates.length = 0;
  mocks.respond.mockClear();
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

describe("per-call tool approvals", () => {
  it("flags a call that needs approval and delivers the answer against the stream id", async () => {
    const p = startConnected();
    await tick();
    const stream = mocks.streams[0];
    expect(get().activeStream?.streamId).toBe(stream.streamId);

    stream.onEvent({ ...CALL, approval_required: true });
    await tick();
    expect(toolCalls("sess-A")[0]).toMatchObject({ id: "call_0_0", awaiting_approval: true, result: null });

    await get().respondToolApproval("call_0_0", "allow_always");
    expect(mocks.respond).toHaveBeenCalledWith(stream.streamId, "call_0_0", "allow_always");
    await tick();
    // Cleared optimistically — the card disappears before the tool result lands.
    expect(toolCalls("sess-A")[0].awaiting_approval).toBeUndefined();

    stream.onEvent({ kind: "tool_result", id: "call_0_0", content: "#42 created", is_error: false });
    stream.onEvent({ kind: "done" });
    await tick();
    await p;
    expect(toolCalls("sess-A")[0]).toMatchObject({ result: "#42 created", is_error: false });
    expect(toolCalls("sess-A")[0].denied).toBeUndefined();
  });

  it("records a denial and ignores answers for calls that are not waiting", async () => {
    const p = startConnected();
    await tick();
    const stream = mocks.streams[0];

    // A call that never needed approval (auto-approved server): answering
    // it is a no-op — nothing to clear, nothing to send.
    stream.onEvent({ ...CALL, id: "call_0_1" });
    await get().respondToolApproval("call_0_1", "deny");
    expect(mocks.respond).not.toHaveBeenCalled();

    stream.onEvent({ ...CALL, approval_required: true });
    await tick();
    stream.onEvent({
      kind: "tool_result",
      id: "call_0_0",
      content: "The user declined to run this tool.",
      is_error: true,
      denied: true,
    });
    stream.onEvent({ kind: "tool_result", id: "call_0_1", content: "ok", is_error: false });
    stream.onEvent({ kind: "done" });
    await tick();
    await p;

    const calls = toolCalls("sess-A");
    const denied = calls.find((c) => c.id === "call_0_0")!;
    expect(denied).toMatchObject({ denied: true, is_error: true });
    expect(denied.awaiting_approval).toBeUndefined();
    expect(calls.find((c) => c.id === "call_0_1")!.denied).toBeUndefined();

    // A late answer after the result landed is dropped, not sent.
    await get().respondToolApproval("call_0_0", "allow_once");
    expect(mocks.respond).not.toHaveBeenCalled();
  });

  it("never persists a call as still awaiting once the stream is stopped", async () => {
    const p = startConnected();
    await tick();
    mocks.streams[0].onEvent({ ...CALL, approval_required: true });
    await tick();
    expect(toolCalls("sess-A")[0].awaiting_approval).toBe(true);

    await get().cancelForSession("sess-A");
    await tick();
    await p;

    const persisted = mocks.updates.at(-1)?.tool_calls_json;
    expect(persisted).toBeTruthy();
    const records = JSON.parse(persisted!) as ToolCallRecord[];
    expect(records[0].id).toBe("call_0_0");
    expect(records[0].awaiting_approval).toBeUndefined();
    // Nothing is streaming, so a stray click has nowhere to go.
    await get().respondToolApproval("call_0_0", "allow_once");
    expect(mocks.respond).not.toHaveBeenCalled();
  });
});
