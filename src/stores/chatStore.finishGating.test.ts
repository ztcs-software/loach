// How a reply ends decides what follows it (`finishRunning`):
//
//   - done: the turn is parked for memory extraction, which starts once
//     nothing else wants the model — sized like the chat's next send, so
//     Ollama keeps the loaded runner — and a chat in the background gets the
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
  extractMemories: vi.fn<typeof import("@/lib/memory").extractMemories>(() => Promise.resolve()),
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
import { useModelsStore } from "./modelsStore";
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

  it("on done, sizes the extraction like the chat's next send", async () => {
    useChatStore.setState({
      sessions: [
        {
          id: "bg",
          provider: "ollama",
          model: "test-model",
          params_json: JSON.stringify({ num_gpu: 20 }),
          space_id: null,
        } as Session,
      ],
    });
    useModelsStore.setState({ modelDefaults: { "test-model": { num_ctx: 32768 } } });
    await runTo({ kind: "done" });
    const runnerOptions = mocks.extractMemories.mock.calls[0][0];
    await expect(runnerOptions?.("bg", "test-model")).resolves.toEqual({ num_ctx: 32768, num_gpu: 20 });
    // Moved to another model since: still sized for the one its turns ran on.
    useChatStore.setState((s) => ({ sessions: s.sessions.map((x) => ({ ...x, model: "other-model" })) }));
    useModelsStore.setState({ modelDefaults: { "test-model": { num_ctx: 32768 }, "other-model": { num_ctx: 4096 } } });
    await expect(runnerOptions?.("bg", "test-model")).resolves.toEqual({ num_ctx: 32768, num_gpu: 20 });
  });

  // X4-04: a reply the max-tokens limit ended passed for a finished one.
  it("on a cut-off done, says so and marks the chat unread, but remembers nothing", async () => {
    await runTo({ kind: "done", cut_off: "max_tokens" } as never);
    const reply = get().messages.bg.at(-1)!;
    expect(reply.content).toMatch(/^Noted\.\n\n_⚠ Cut off at the Max Tokens limit/);
    expect(mocks.queueMemoryTurn).not.toHaveBeenCalled();
    expect(mocks.extractMemories).not.toHaveBeenCalled();
    expect(get().unread).toEqual({ bg: true });
  });

  // A full context window ends a reply the same way, but blaming Max Tokens
  // sent the user to a setting that did nothing for it.
  it("on a done cut off by the context window, points at Context Length, not Max Tokens", async () => {
    await runTo({ kind: "done", cut_off: "context", tools: true } as never);
    const reply = get().messages.bg.at(-1)!;
    expect(reply.content).toMatch(
      /^Noted\.\n\n_⚠ Cut off: the context window is full — raise Context Length in Parameters, or turn off tools/,
    );
    expect(reply.content).not.toMatch(/Max Tokens/);
    expect(mocks.queueMemoryTurn).not.toHaveBeenCalled();
  });

  // Tools come up only where some went out with the request.
  it("on a context cut-off with no tools sent, leaves tools out of the note", async () => {
    await runTo({ kind: "done", cut_off: "context" } as never);
    const reply = get().messages.bg.at(-1)!;
    expect(reply.content).toMatch(/raise Context Length in Parameters\._$/);
    expect(reply.content).not.toMatch(/tools/);
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
      default_model_choice: "model:ollama:global-model:1b",
      default_provider: "ollama",
      default_model: "global-model:1b",
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
    expect([s.provider, s.model]).toEqual(["ollama", "global-model:1b"]);
  });

  it("lets a model named by the caller win over the pin", async () => {
    useSpaceStore.setState({ spaces: [space({ default_provider: "openai", default_model: "gpt-4o" })] });
    const s = await get().newSession({ spaceId: "sp", provider: "ollama", model: "picked:8b" });
    expect([s.provider, s.model]).toEqual(["ollama", "picked:8b"]);
  });
});
