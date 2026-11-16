// A reply is saved while it streams (X4-01).
//
// The only full write of a reply used to be `finishRunning`'s, so a quit,
// reload, crash or update mid-reply left an empty assistant row — and no
// record of the tools it had run, files it wrote included. Each interim save
// is the row as it should read if Loach stopped right then; the final write
// replaces it, and never lands before one of them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "@/types";

type Write = { id: string; content: string; tool_calls_json?: string | null };

const mocks = vi.hoisted(() => ({
  streams: [] as Array<{ onEvent: (ev: unknown) => void }>,
  writes: [] as Write[],
  /** Hold the next write until `release` — a slow interim save. */
  holdNext: false,
  release: null as null | (() => void),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    updateMessage: vi.fn((args: Write) => {
      if (mocks.holdNext) {
        mocks.holdNext = false;
        return new Promise<void>((resolve) => {
          mocks.release = () => {
            mocks.writes.push(args);
            resolve();
          };
        });
      }
      mocks.writes.push(args);
      return Promise.resolve();
    }),
    startChatStream: vi.fn((request: { stream_id: string }, onEvent: (ev: unknown) => void) => {
      mocks.streams.push({ onEvent });
      return Promise.resolve({ streamId: request.stream_id, stop: () => Promise.resolve(), unlisten: () => undefined });
    }),
  };
});

import { useChatStore, __testing } from "./chatStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const set = ((p: unknown) => useChatStore.setState(p as never)) as Parameters<typeof __testing.startTask>[2];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const NOTE = "_⚠ Reply interrupted — Loach closed before it finished._";

async function start() {
  const task = {
    id: "task-1",
    sessionId: "c",
    userMsgId: "u1",
    request: { provider: "ollama", model: "m", base_url: "http://localhost:11434", system_prompt: null, messages: [], params: {} },
    memoryScope: { kind: "global" },
  } as unknown as Parameters<typeof __testing.startTask>[0];
  await __testing.startTask(task, get, set);
  return mocks.streams[0].onEvent;
}

beforeEach(() => {
  mocks.streams.length = 0;
  mocks.writes.length = 0;
  mocks.holdNext = false;
  mocks.release = null;
  __testing.resetForTests();
  useChatStore.setState({
    sessions: [],
    activeSessionId: "c",
    messages: { c: [{ id: "u1", session_id: "c", role: "user", content: "write it" } as Message] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("saving a reply while it streams", () => {
  it("is saved as interrupted from the start, and each tool call at once", async () => {
    const emit = await start();
    await tick();
    expect(mocks.writes.at(-1)?.content).toBe(NOTE);

    emit({ kind: "token", delta: "Writing the file." });
    emit({ kind: "tool_call", id: "c1", server_id: "__builtin__", server_name: "Loach", tool: "write_file", arguments: { path: "a.txt" } });
    await tick();
    const saved = mocks.writes.at(-1)!;
    expect(saved.content).toBe(`Writing the file.\n\n${NOTE}`);
    // On record before it runs, as it would read after a crash.
    const [call] = JSON.parse(saved.tool_calls_json!);
    expect(call).toMatchObject({ tool: "write_file", interrupted: true, is_error: false });
    expect(call.result).toMatch(/may or may not have completed/);
  });

  it("writes the final reply after any interim save still under way", async () => {
    const emit = await start();
    await tick();
    emit({ kind: "token", delta: "Done" });
    mocks.holdNext = true;
    emit({ kind: "tool_call", id: "c1", server_id: "__builtin__", server_name: "Loach", tool: "write_file", arguments: {} });
    emit({ kind: "tool_result", id: "c1", content: "ok", is_error: false });
    emit({ kind: "done" });
    await tick();
    // The slow interim save holds everything behind it…
    expect(mocks.writes.at(-1)?.content).toBe(NOTE);
    mocks.release!();
    await tick();
    // …and the finished reply is the last word, with no note.
    const final = mocks.writes.at(-1)!;
    expect(final.content).toBe("Done");
    expect(JSON.parse(final.tool_calls_json!)[0]).toMatchObject({ result: "ok" });
  });
});
