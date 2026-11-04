// Memory extraction across chats, driven through the store's real send path
// with a mocked backend.
//
// A send aborts whichever extraction is running, in any chat. The aborted
// turn used to be parked under its own chat and read back only by that
// chat's next idle reply — so moving on to another chat left it waiting
// (and a restart lost it). It now runs the next time a reply ends with the
// app idle, wherever that reply was, into its own scope: the Space the chat
// was in when the message was sent, even if the chat moved since. A reply
// Regenerate replaces stays out of every later run.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, Space } from "@/types";

const mocks = vi.hoisted(() => {
  interface FakeStream {
    request: Record<string, unknown>;
    onEvent: (ev: unknown) => void;
    listening: boolean;
  }
  return {
    streams: [] as FakeStream[],
    spaceAdds: [] as Array<{ space_id: string; content: string }>,
    globalAdds: [] as string[],
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  let seq = 0;
  const row = (content: string) => ({
    id: `mem-${++seq}`,
    content,
    source_session_id: null,
    source_message_id: null,
    created_at: seq,
    updated_at: seq,
  });
  return {
    ...actual,
    // Connects at once; the test answers each stream by hand. Stopping one
    // that is still listened to ends it `cancelled`, as the backend does.
    startChatStream: vi.fn(async (request: Record<string, unknown>, onEvent: (ev: unknown) => void) => {
      const s = { request, onEvent, listening: true };
      mocks.streams.push(s);
      return {
        streamId: String(request.stream_id),
        stop: async () => {
          if (s.listening) onEvent({ kind: "cancelled" });
        },
        unlisten: () => {
          s.listening = false;
        },
      };
    }),
    addSpaceMemory: vi.fn(async (args: { space_id: string; content: string }) => {
      mocks.spaceAdds.push({ space_id: args.space_id, content: args.content });
      return { ...row(args.content), space_id: args.space_id };
    }),
    addGlobalMemory: vi.fn(async (args: { content: string }) => {
      mocks.globalAdds.push(args.content);
      return row(args.content);
    }),
  };
});

import { useChatStore, __testing } from "./chatStore";
import { useGlobalMemoryStore } from "./globalMemoryStore";
import { useLibraryStore } from "./libraryStore";
import { useSettingsStore } from "./settingsStore";
import { useSpaceStore } from "./spaceStore";

// The extractor and the toast store call `window.setTimeout`.
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const chats = () => mocks.streams.filter((s) => !s.request.no_tools);
const extractors = () => mocks.streams.filter((s) => s.request.no_tools);
const userPrompt = (s: { request: Record<string, unknown> }) =>
  String((s.request.messages as Array<{ content: string }>)[0].content);

function answer(stream: { onEvent: (ev: unknown) => void }, text: string) {
  stream.onEvent({ kind: "token", delta: text });
  stream.onEvent({ kind: "done" });
}

function session(id: string, spaceId: string | null): Session {
  return {
    id,
    title: id,
    provider: "openai",
    model: "test-model",
    system_prompt: null,
    params_json: null,
    space_id: spaceId,
    pinned_at: null,
    archived_at: null,
    forked_from_session_id: null,
    label: null,
    folder_id: null,
    workspace_root: null,
    retrieval_mode: null,
    image_scaling_json: null,
    created_at: 0,
    updated_at: 0,
  };
}

const space = {
  id: "sp1",
  name: "Home",
  description: "",
  instructions: "",
  default_provider: null,
  default_model: null,
  default_params_json: null,
  memory_enabled: true,
  retrieval_mode: "auto",
  image_scaling_json: null,
  created_at: 0,
  updated_at: 0,
} satisfies Space;

/** Send in `chatId` and let its stream connect. */
async function send(chatId: string, text: string) {
  useChatStore.setState({ activeSessionId: chatId });
  await get().sendUserMessage(text, []);
}

beforeEach(() => {
  mocks.streams.length = 0;
  mocks.spaceAdds.length = 0;
  mocks.globalAdds.length = 0;
  __testing.resetForTests();
  useSettingsStore.setState({ global_memory_enabled: true, temporal_awareness: false });
  useGlobalMemoryStore.setState({ memories: null });
  useSpaceStore.setState({ spaces: [space], spaceMemories: {}, viewingSpaceId: null, activeSpaceId: null });
  useLibraryStore.setState({ hydrated: true, error: null, items: [], datasets: [], sources: {} });
  useChatStore.setState({
    sessions: [session("A", "sp1"), session("B", null)],
    activeSessionId: "A",
    messages: { A: [], B: [] },
    streamingByMessage: {},
    activeStream: null,
    isStreaming: false,
    streamingSessionId: null,
    runningTask: null,
    queue: [],
    unread: {},
  } as never);
});

describe("memory extraction across chats", () => {
  it("runs a turn a send in another chat cut short once the app is idle, in its own scope", async () => {
    await send("A", "I live in Gdańsk");
    answer(chats()[0], "Nice city.");
    await vi.waitFor(() => expect(extractors()).toHaveLength(1));

    // On to chat B: its send aborts A's extraction.
    await send("B", "I have a dog called Burek");
    expect(extractors()[0].listening).toBe(false);

    // B's reply ends with nothing else waiting — A's parked turn runs, then
    // B's, each on its own.
    answer(chats()[1], "Dogs are great.");
    await vi.waitFor(() => expect(extractors()).toHaveLength(2));
    expect(userPrompt(extractors()[1])).toContain("I live in Gdańsk");
    expect(userPrompt(extractors()[1])).not.toContain("Burek");
    answer(extractors()[1], JSON.stringify({ add: ["Lives in Gdańsk"] }));

    await vi.waitFor(() => expect(extractors()).toHaveLength(3));
    expect(userPrompt(extractors()[2])).toContain("Burek");
    expect(userPrompt(extractors()[2])).not.toContain("Gdańsk");
    answer(extractors()[2], JSON.stringify({ add: ["Has a dog called Burek"] }));

    await vi.waitFor(() => expect(mocks.globalAdds).toEqual(["Has a dog called Burek"]));
    expect(mocks.spaceAdds).toEqual([{ space_id: "sp1", content: "Lives in Gdańsk" }]);
  });

  it("remembers in the Space the message was sent from, though the chat moved since", async () => {
    await send("A", "I live in Gdańsk");
    // Moved out of the Space while the reply streams.
    await get().moveToSpace("A", null);
    answer(chats()[0], "Nice city.");
    await vi.waitFor(() => expect(extractors()).toHaveLength(1));
    answer(extractors()[0], JSON.stringify({ add: ["Lives in Gdańsk"] }));

    await vi.waitFor(() => expect(mocks.spaceAdds).toEqual([{ space_id: "sp1", content: "Lives in Gdańsk" }]));
    expect(mocks.globalAdds).toEqual([]);
  });

  it("keeps a reply Regenerate replaced out of every later run", async () => {
    await send("B", "I have a cat");
    answer(chats()[0], "Rejected answer: you have three cats.");
    await vi.waitFor(() => expect(extractors()).toHaveLength(1));

    // Regenerate aborts the run reading the old reply; the `cancelled` that
    // follows must not park that reply again.
    await get().regenerateLast("B");
    expect(extractors()[0].listening).toBe(false);
    answer(chats()[1], "Accepted answer.");

    await vi.waitFor(() => expect(extractors()).toHaveLength(2));
    const prompt = userPrompt(extractors()[1]);
    expect(prompt).toContain("Accepted answer.");
    expect(prompt).not.toContain("Rejected answer");
    expect(prompt).toContain("Conversation turn 1 of 1");
  });
});
