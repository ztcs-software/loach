// Coverage for the folder actions' two non-obvious behaviours:
//
//   - `createFolderWith` is a compound operation — one create followed by
//     one move per chat. A regression that creates the folder but skips the
//     moves looks fine in the sidebar (an empty folder appears) while the
//     chats silently stay where they were.
//   - `removeFolder` mirrors the backend's ON DELETE SET NULL in memory. If
//     it dropped the sessions instead of clearing their `folder_id`, the
//     chats would vanish from the sidebar until the next launch — the DB
//     still has them, so nothing would look broken until a reload.
//
// `createFolder` / `renameFolder` fall through to the real wrappers: outside
// Tauri they already no-op into a mock Folder, which is all these tests need.
// `setSessionFolder` / `deleteFolder` are spied on so we can assert the call
// sequence rather than just the resulting state.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  // Parameters are spelled out so `mock.calls` stays typed — an argless
  // `vi.fn()` infers an empty tuple and indexing a call fails to compile.
  setSessionFolder: vi.fn((_args: { id: string; folder_id: string | null }) =>
    Promise.resolve(),
  ),
  deleteFolder: vi.fn((_id: string) => Promise.resolve()),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    setSessionFolder: mocks.setSessionFolder,
    deleteFolder: mocks.deleteFolder,
  };
});

import { useChatStore } from "./chatStore";
import type { Folder, Session } from "@/types";

const get = () => useChatStore.getState();

function session(id: string, folderId: string | null = null): Session {
  return {
    id,
    title: id,
    provider: "ollama",
    model: "llama3",
    system_prompt: null,
    params_json: null,
    space_id: null,
    pinned_at: null,
    archived_at: null,
    forked_from_session_id: null,
    label: null,
    folder_id: folderId,
    created_at: 0,
    updated_at: 0,
  };
}

function folder(id: string, name: string): Folder {
  return { id, name, created_at: 0, updated_at: 0 };
}

beforeEach(() => {
  mocks.setSessionFolder.mockClear();
  mocks.deleteFolder.mockClear();
  useChatStore.setState({ sessions: [], folders: [] });
});

describe("chatStore folders", () => {
  it("createFolderWith moves every named chat into the new folder", async () => {
    useChatStore.setState({
      sessions: [session("a"), session("b"), session("c")],
    });

    const created = await get().createFolderWith("Research", ["a", "b"]);

    expect(mocks.setSessionFolder.mock.calls.map((c) => c[0])).toEqual([
      { id: "a", folder_id: created.id },
      { id: "b", folder_id: created.id },
    ]);
    expect(get().folders.map((f) => f.name)).toEqual(["Research"]);
    expect(get().sessions.map((s) => s.folder_id)).toEqual([
      created.id,
      created.id,
      null,
    ]);
  });

  it("keeps folders in name order so the sidebar section stays alphabetical", async () => {
    await get().createFolderWith("Zebra", []);
    await get().createFolderWith("apple", []);

    // Case-insensitive: "apple" sorts before "Zebra", not after it the way a
    // plain ASCII comparison would put it.
    expect(get().folders.map((f) => f.name)).toEqual(["apple", "Zebra"]);
  });

  it("renameFolder re-sorts rather than leaving the list in the old order", async () => {
    useChatStore.setState({
      folders: [folder("f1", "Alpha"), folder("f2", "Beta")],
    });

    await get().renameFolder("f1", "Zulu");

    expect(get().folders.map((f) => f.name)).toEqual(["Beta", "Zulu"]);
  });

  it("removeFolder releases its chats instead of deleting them", async () => {
    useChatStore.setState({
      sessions: [session("a", "f1"), session("b", "f1"), session("c")],
      folders: [folder("f1", "Research")],
    });

    await get().removeFolder("f1");

    expect(mocks.deleteFolder).toHaveBeenCalledWith("f1");
    expect(get().folders).toEqual([]);
    // All three chats survive; the two that were filed are loose again.
    expect(get().sessions.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(get().sessions.map((s) => s.folder_id)).toEqual([null, null, null]);
  });

  it("moveToFolder pulls a chat back out when given null", async () => {
    useChatStore.setState({ sessions: [session("a", "f1")] });

    await get().moveToFolder("a", null);

    expect(mocks.setSessionFolder).toHaveBeenCalledWith({
      id: "a",
      folder_id: null,
    });
    expect(get().sessions[0].folder_id).toBeNull();
  });
});
