// How a reply ends decides what follows it (`finishRunning`):
//
//   - done: the turn is parked for memory extraction, which starts once
//     nothing else wants the model, and a chat in the background gets the
//     unread dot;
//   - cancelled: neither — the user said they were done with this turn;
//   - error: no extraction, but the dot, so a failure in a chat nobody is
//     looking at doesn't go unnoticed.
//
// And which model a new chat starts on when it lands in a Space that pins
// one: the Space's pin, unless it's half set or the caller names a model.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session, Space } from "@/types";

const mocks = vi.hoisted(() => ({
  streams: [] as Array<{ onEvent: (ev: unknown) => void }>,
  queueMemoryTurn: vi.fn(),
  extractMemories: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    startChatStream: vi.fn((request: { stream_id: string }, onEvent: (ev: unknown) => void) => {
      mocks.streams.push({ onEvent });
      return Promise.resolve({
        streamId: request.stream_id,
        stop: () => Promise.resolve(),
        unlisten: () => undefined,
      });
    }),
  };
});

vi.mock("@/lib/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory")>();
  return {
    ...actual,
    queueMemoryTurn: mocks.queueMemoryTurn,
    extractMemories: mocks.extractMemories,
  };
});

import { useChatStore, __testing } from "./chatStore";
import { useSettingsStore } from "./settingsStore";
import { useSpaceStore } from "./spaceStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const set = ((p: unknown) =>
  useChatStore.setState(p as never)) as Parameters<typeof __testing.startTask>[2];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const userTurn = { id: "u1", session_id: "bg", role: "user", content: "I live in Lisbon" } as Message;

async function runTo(end: { kind: string; message?: string }) {
  const task = {
    id: "task-1",
    sessionId: "bg",
    userMsgId: "u1",
    request: {
      provider: "ollama",
      model: "test-model",
      base_url: "http://localhost:11434",
      system_prompt: null,
      messages: [],
      params: {},
    },
    memoryScope: { kind: "global" },
  } as unknown as Parameters<typeof __testing.startTask>[0];
  await __testing.startTask(task, get, set);
  mocks.streams[0].onEvent({ kind: "token", delta: "Noted." });
  mocks.streams[0].onEvent(end);
  await tick();
}

describe("finishRunning", () => {
  beforeEach(() => {
    mocks.streams.length = 0;
    mocks.queueMemoryTurn.mockClear();
    mocks.extractMemories.mockClear();
    __testing.resetForTests();
    useSettingsStore.setState({ global_memory_enabled: true });
    useChatStore.setState({
      sessions: [],
      // The reply streams into "bg" while the user looks at another chat.
      activeSessionId: "fg",
      messages: { bg: [userTurn], fg: [] },
      streamingByMessage: {},
      activeStream: null,
      isStreaming: false,
      streamingSessionId: null,
      runningTask: null,
      queue: [],
      unread: {},
    } as never);
  });

  it("on done, remembers the turn and marks the chat unread", async () => {
    await runTo({ kind: "done" });
    expect(mocks.queueMemoryTurn).toHaveBeenCalledTimes(1);
    expect(mocks.queueMemoryTurn.mock.calls[0][0]).toMatchObject({
      sessionId: "bg",
      turn: { userText: "I live in Lisbon", assistantText: "Noted." },
    });
    expect(mocks.extractMemories).toHaveBeenCalledTimes(1);
    expect(get().unread).toEqual({ bg: true });
  });

  it("on cancel, does neither", async () => {
    await runTo({ kind: "cancelled" });
    expect(mocks.queueMemoryTurn).not.toHaveBeenCalled();
    expect(mocks.extractMemories).not.toHaveBeenCalled();
    expect(get().unread).toEqual({});
    expect(get().runningTask).toBeNull();
  });

  it("on error, marks the chat unread but remembers nothing", async () => {
    await runTo({ kind: "error", message: "model crashed" });
    expect(mocks.queueMemoryTurn).not.toHaveBeenCalled();
    expect(mocks.extractMemories).not.toHaveBeenCalled();
    expect(get().unread).toEqual({ bg: true });
  });
});

describe("newSession in a Space that pins a model", () => {
  const space = (fields: Partial<Space>) =>
    ({ id: "sp", name: "Space", default_provider: null, default_model: null, ...fields }) as Space;

  beforeEach(() => {
    useSettingsStore.setState({
      default_model_choice: "model:ollama:global-model",
      default_provider: "ollama",
      default_model: "global-model",
    });
    useChatStore.setState({ sessions: [] as Session[], activeSessionId: null, messages: {} });
  });

  it("starts on the Space's model", async () => {
    useSpaceStore.setState({ spaces: [space({ default_provider: "openai", default_model: "gpt-4o" })] });
    const s = await get().newSession({ spaceId: "sp" });
    expect([s.provider, s.model]).toEqual(["openai", "gpt-4o"]);
  });

  it("falls through to the global default when the pin is half set", async () => {
    useSpaceStore.setState({ spaces: [space({ default_provider: "openai", default_model: null })] });
    const s = await get().newSession({ spaceId: "sp" });
    expect([s.provider, s.model]).toEqual(["ollama", "global-model"]);
  });

  it("lets a model named by the caller win over the pin", async () => {
    useSpaceStore.setState({ spaces: [space({ default_provider: "openai", default_model: "gpt-4o" })] });
    const s = await get().newSession({ spaceId: "sp", provider: "ollama", model: "picked" });
    expect([s.provider, s.model]).toEqual(["ollama", "picked"]);
  });
});
