// A message typed on a Space's page starts a new chat in that Space.
//
// It used to be appended to the chat left open whenever that chat belonged to
// the same Space — so going from a chat to its Space's page (the header's
// Space link) and asking something new quietly continued the old thread.
//
// Also here: moving an existing chat into or out of a Space.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session } from "@/types";

const calls = vi.hoisted(() => ({ appended: [] as string[] }));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  let seq = 0;
  return {
    ...actual,
    sessionMessageCounts: vi.fn(async () => ({})),
    deleteSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => [] as Message[]),
    libraryListSources: vi.fn(async () => []),
    createSession: vi.fn(async (args: { space_id: string | null }) => ({
      id: `chat-${++seq}`,
      title: "New chat",
      provider: "ollama",
      model: "test-model",
      system_prompt: null,
      params_json: null,
      space_id: args.space_id,
      pinned_at: null,
      archived_at: null,
      forked_from_session_id: null,
      label: null,
      folder_id: null,
      workspace_root: null,
      retrieval_mode: null,
      created_at: 0,
      updated_at: 0,
    })),
    appendMessage: vi.fn(async (args: { session_id: string; role: string; content: string }) => {
      if (args.role === "user") calls.appended.push(args.session_id);
      return {
        id: `m-${++seq}`,
        session_id: args.session_id,
        role: args.role,
        content: args.content,
        created_at: seq,
      };
    }),
    startChatStream: vi.fn((request: { stream_id: string }) =>
      Promise.resolve({ streamId: request.stream_id, stop: () => Promise.resolve(), unlisten: () => undefined }),
    ),
  };
});

import { useChatStore, __testing } from "./chatStore";
import { useSpaceStore } from "./spaceStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();

const oldChat = {
  id: "old",
  title: "Earlier thread",
  provider: "ollama",
  model: "test-model",
  space_id: "space-A",
  archived_at: null,
  updated_at: 0,
} as Session;

beforeEach(() => {
  calls.appended = [];
  __testing.resetForTests();
  useSpaceStore.setState({
    spaces: [{ id: "space-A", name: "A" }] as never,
    viewingSpaceId: null,
    activeSpaceId: null,
  });
  useChatStore.setState({
    sessions: [oldChat],
    activeSessionId: "old",
    messages: { old: [{ id: "m0", session_id: "old", role: "user", content: "hi", created_at: 0 }] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("sending from a Space's page", () => {
  it("starts a new chat even when the open chat belongs to that Space", async () => {
    useSpaceStore.getState().setViewingSpace("space-A");
    await get().sendUserMessage("a new question", []);

    const created = get().activeSessionId;
    expect(created).not.toBe("old");
    expect(get().sessions.find((s) => s.id === created)?.space_id).toBe("space-A");
    expect(calls.appended).toEqual([created]);
    expect(get().messages.old).toHaveLength(1);
  });

  it("still continues the open chat from the chat itself", async () => {
    await get().sendUserMessage("a follow-up", []);
    expect(get().activeSessionId).toBe("old");
    expect(calls.appended).toEqual(["old"]);
  });
});

describe("moving a chat between Spaces", () => {
  it("moves it in and out, keeping its place in the list", async () => {
    await get().moveToSpace("old", "space-B");
    expect(get().sessions[0]).toMatchObject({ id: "old", space_id: "space-B", updated_at: 0 });

    await get().moveToSpace("old", null);
    expect(get().sessions[0].space_id).toBeNull();
  });
});
