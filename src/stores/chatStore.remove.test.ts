// Coverage for `remove()`'s fallback selection — the branch that runs when the
// user deletes the chat they're currently looking at. Two things have to hold,
// and a regression in either is invisible in the DB afterwards:
//
//   - The replacement must be a chat the sidebar actually SHOWS. `sessions` is
//     ordered by `updated_at` and includes archived rows, and `archive` bumps
//     `updated_at` — so a naive `sessions[0]` lands on the chat the user just
//     archived, which no sidebar group renders.
//   - The replacement's transcript must be LOADED. Under lazy hydration
//     `selectSession` is the only loader, so patching `activeSessionId`
//     directly leaves the canvas showing the "How can I help today?" hero over
//     a chat that has messages, until the user clicks it again.
//
// `deleteSession` and `listMessages` are spied on so we can assert the call
// sequence rather than just the resulting state.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session } from "@/types";

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn((_id: string) => Promise.resolve()),
  listMessages: vi.fn((_id: string) => Promise.resolve([] as Message[])),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    deleteSession: mocks.deleteSession,
    listMessages: mocks.listMessages,
  };
});

import { useChatStore } from "./chatStore";

const get = () => useChatStore.getState();

function session(id: string, updatedAt: number, archived = false): Session {
  return {
    id,
    title: id,
    provider: "ollama",
    model: "llama3",
    system_prompt: null,
    params_json: null,
    space_id: null,
    pinned_at: null,
    archived_at: archived ? 1 : null,
    forked_from_session_id: null,
    label: null,
    folder_id: null,
    created_at: 0,
    updated_at: updatedAt,
  };
}

beforeEach(() => {
  mocks.deleteSession.mockClear();
  mocks.listMessages.mockClear();
  useChatStore.setState({
    sessions: [],
    folders: [],
    activeSessionId: null,
    messages: {},
    queue: [],
    runningTask: null,
    unread: {},
  });
});

describe("chatStore remove", () => {
  it("falls back to the newest UNARCHIVED chat, not just the newest row", async () => {
    // Sidebar order: an archived chat sorts first because archiving bumped
    // its `updated_at`. Picking it would strand the user on a chat no group
    // in the sidebar draws.
    useChatStore.setState({
      sessions: [
        session("archived", 300, true),
        session("keep", 200),
        session("doomed", 100),
      ],
      activeSessionId: "doomed",
    });

    await get().remove("doomed");

    expect(mocks.deleteSession).toHaveBeenCalledWith("doomed");
    expect(get().activeSessionId).toBe("keep");
  });

  it("loads the replacement's transcript instead of leaving it unhydrated", async () => {
    useChatStore.setState({
      sessions: [session("keep", 200), session("doomed", 100)],
      activeSessionId: "doomed",
      // Only the doomed chat is resident — "keep" has never been opened, so
      // nothing but `selectSession` will fetch it.
      messages: { doomed: [] },
    });

    await get().remove("doomed");

    expect(mocks.listMessages).toHaveBeenCalledWith("keep");
    expect(get().messages.keep).toEqual([]);
    expect(get().messages.doomed).toBeUndefined();
  });

  it("leaves the active chat (and the network) alone when deleting another one", async () => {
    useChatStore.setState({
      sessions: [session("active", 200), session("doomed", 100)],
      activeSessionId: "active",
    });

    await get().remove("doomed");

    expect(get().activeSessionId).toBe("active");
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });

  it("clears the selection when every survivor is archived", async () => {
    useChatStore.setState({
      sessions: [session("archived", 300, true), session("doomed", 100)],
      activeSessionId: "doomed",
    });

    await get().remove("doomed");

    expect(get().activeSessionId).toBeNull();
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });
});
