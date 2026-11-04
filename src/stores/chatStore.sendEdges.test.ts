// Edges of `sendUserMessage` between the user's turn and its reply:
//
//   - A send still preparing when Private Chat opened started behind the
//     overlay: the direct-start path never checked the queue hold.
//   - "New chat" pressed while a chat's first message was still preparing
//     (a web fetch, say) culled that chat as empty — under the send.
//   - A reply whose placeholder couldn't be written left the user's turn
//     unanswered, with no error and no toast.
//   - A failed auto-title failed the whole send after the turn was saved, so
//     the composer put the draft back and a resend duplicated it.
//   - An open chat deleted elsewhere left the send to throw on its session.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session } from "@/types";

const mocks = vi.hoisted(() => ({
  /** Park the next user-turn append until `release` is called. */
  parkUserTurn: false,
  release: null as null | (() => void),
  failAssistantTurn: false,
  failRename: false,
  deleted: [] as string[],
  streams: 0,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  let seq = 0;
  return {
    ...actual,
    listMessages: vi.fn(() => Promise.resolve([] as Message[])),
    appendMessage: vi.fn((args: { session_id: string; role: string; content: string }) => {
      if (args.role === "assistant" && mocks.failAssistantTurn) {
        return Promise.reject(new Error("database is locked"));
      }
      const msg = {
        id: `m-${++seq}`,
        session_id: args.session_id,
        role: args.role,
        content: args.content,
        thinking: null,
        attachments_json: null,
        metrics_json: null,
        tool_calls_json: null,
        compacted_at: null,
        import_group: null,
        import_hidden: false,
        pinned_at: null,
        created_at: seq,
      } as unknown as Message;
      if (args.role === "user" && mocks.parkUserTurn) {
        mocks.parkUserTurn = false;
        return new Promise((resolve) => (mocks.release = () => resolve(msg)));
      }
      return Promise.resolve(msg);
    }),
    renameSession: vi.fn(() =>
      mocks.failRename ? Promise.reject(new Error("rename failed")) : Promise.resolve(),
    ),
    deleteSession: vi.fn(async (id: string) => {
      mocks.deleted.push(id);
    }),
    startChatStream: vi.fn((request: { stream_id: string }) => {
      mocks.streams += 1;
      return Promise.resolve({
        streamId: request.stream_id,
        stop: () => Promise.resolve(),
        unlisten: () => undefined,
      });
    }),
  };
});

vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

import { useChatStore, __testing } from "./chatStore";
import { useSettingsStore } from "./settingsStore";
import { useToastStore } from "./toastStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const get = () => useChatStore.getState();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function session(id: string): Session {
  return {
    id,
    title: "New chat",
    provider: "ollama",
    model: "test-model",
    system_prompt: null,
    params_json: null,
    space_id: null,
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

beforeEach(() => {
  Object.assign(mocks, {
    parkUserTurn: false,
    release: null,
    failAssistantTurn: false,
    failRename: false,
    deleted: [],
    streams: 0,
  });
  __testing.resetForTests();
  useToastStore.getState().clear();
  useSettingsStore.setState({ default_model_choice: "model:ollama:test-model", web_fetch_enabled: false });
  useChatStore.setState({
    sessions: [session("sess-A")],
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

describe("sendUserMessage edges", () => {
  it("parks a send while Private Chat holds the queue, and starts it on release", async () => {
    get().setQueueHeld(true);
    await get().sendUserMessage("hi", []);
    expect(get().runningTask).toBeNull();
    expect(get().queue.map((t) => t.sessionId)).toEqual(["sess-A"]);
    expect(mocks.streams).toBe(0);

    get().setQueueHeld(false);
    await vi.waitFor(() => expect(get().runningTask?.sessionId).toBe("sess-A"));
    expect(get().queue).toEqual([]);
  });

  it("doesn't cull the chat a first message is still being prepared for", async () => {
    mocks.parkUserTurn = true;
    const sending = get().sendUserMessage("hi", []);
    await tick();

    await get().newSession({ spaceId: null });
    expect(mocks.deleted).not.toContain("sess-A");

    mocks.release!();
    await sending;
    expect(get().sessions.map((s) => s.id)).toContain("sess-A");
  });

  it("says so when the reply can't be created, instead of failing silently", async () => {
    mocks.failAssistantTurn = true;
    await get().sendUserMessage("hi", []);

    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Couldn't start the reply");
    // The turn is saved and nothing waits on it: no throw (a resend would
    // duplicate it), no task left running or parked.
    expect(get().messages["sess-A"].map((m) => m.role)).toEqual(["user"]);
    expect(get().runningTask).toBeNull();
    expect(get().queue).toEqual([]);
  });

  it("still sends when the auto-title can't be saved", async () => {
    mocks.failRename = true;
    await get().sendUserMessage("hi", []);
    expect(get().runningTask?.sessionId).toBe("sess-A");
  });

  it("starts a new chat when the open one has been deleted", async () => {
    useChatStore.setState({ sessions: [], activeSessionId: "deleted", messages: {} });
    await get().sendUserMessage("hi", []);
    const active = get().activeSessionId;
    expect(active).not.toBe("deleted");
    expect(get().sessions.map((s) => s.id)).toEqual([active]);
    expect(get().runningTask?.sessionId).toBe(active);
  });
});
