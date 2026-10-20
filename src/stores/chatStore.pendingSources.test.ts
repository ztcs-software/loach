// Library sources picked in the composer before its chat exists (the
// welcome screen, a Space's page) belong to the chat that composer creates.
//
// They used to be taken by `newSession` itself, so whichever chat was created
// next got them — one started from the sidebar, a shortcut or the Library's
// "Chat with it", or a send from another Space's page.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session } from "@/types";

const calls = vi.hoisted(() => ({ linked: [] as Array<{ ownerId: string; itemIds: string[] }> }));

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
    libraryAddSources: vi.fn(async (args: { ownerId: string; itemIds: string[] }) => {
      calls.linked.push({ ownerId: args.ownerId, itemIds: args.itemIds });
      return [];
    }),
    appendMessage: vi.fn(async (args: { session_id: string; role: string; content: string }) => ({
      id: `m-${++seq}`,
      session_id: args.session_id,
      role: args.role,
      content: args.content,
      created_at: seq,
    })),
    startChatStream: vi.fn((request: { stream_id: string }) =>
      Promise.resolve({ streamId: request.stream_id, stop: () => Promise.resolve(), unlisten: () => undefined }),
    ),
  };
});

import { useChatStore, __testing } from "./chatStore";
import { useLibraryStore } from "./libraryStore";
import { useSpaceStore } from "./spaceStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const pick = (itemId: string, spaceId: string | null) =>
  useLibraryStore.getState().addPending({ itemIds: [itemId], datasetIds: [] }, spaceId);

beforeEach(() => {
  calls.linked = [];
  __testing.resetForTests();
  useLibraryStore.setState({
    hydrated: true,
    items: [],
    datasets: [],
    sources: {},
    pending: { itemIds: [], datasetIds: [], spaceId: null },
  });
  useSpaceStore.setState({ viewingSpaceId: null, activeSpaceId: null });
  useChatStore.setState({
    sessions: [] as Session[],
    activeSessionId: null,
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

describe("sources picked before the chat exists", () => {
  it("go to the chat the composer creates, not one started another way", async () => {
    pick("doc", null);

    // A chat from the sidebar's New chat (or a shortcut, or "Chat with it").
    await get().newSession({ spaceId: null });
    expect(calls.linked).toEqual([]);

    // The composer's own send, with no chat open, still takes them.
    useChatStore.setState({ activeSessionId: null });
    await get().sendUserMessage("hello", []);
    expect(calls.linked).toEqual([{ ownerId: get().activeSessionId, itemIds: ["doc"] }]);
    expect(useLibraryStore.getState().pending.itemIds).toEqual([]);
  });

  it("stay with the Space whose page they were picked on", async () => {
    useSpaceStore.setState({ spaces: [{ id: "space-B", name: "B" }] as never });
    pick("for-A", "space-A");

    // Sent from Space B's page: the picks for A are dropped, not attached.
    useSpaceStore.setState({ viewingSpaceId: "space-B", activeSpaceId: "space-B" });
    await get().sendUserMessage("hello", []);
    expect(calls.linked).toEqual([]);

    // Picked and sent on the same page: attached.
    useChatStore.setState({ activeSessionId: null });
    pick("for-B", "space-B");
    useSpaceStore.setState({ viewingSpaceId: "space-B", activeSpaceId: "space-B" });
    await get().sendUserMessage("again", []);
    expect(calls.linked).toEqual([{ ownerId: get().activeSessionId, itemIds: ["for-B"] }]);
  });
});
