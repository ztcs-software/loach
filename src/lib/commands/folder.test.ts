// `/folder <name>` files the chat into the folder with exactly that name
// (case-insensitive) or creates one — never a substring match, which could
// file it into the wrong existing folder.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Folder, Session } from "@/types";

const setSessionFolder = vi.hoisted(() =>
  vi.fn(async (_args: { id: string; folder_id: string | null }) => {}),
);
const createFolder = vi.hoisted(() =>
  vi.fn(async (name: string) => ({ id: "new-folder", name, created_at: 1, updated_at: 1 })),
);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, setSessionFolder, createFolder };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

function openChat(folder_id: string | null) {
  useChatStore.setState({
    folders: [{ id: "work", name: "Work" } as Folder],
    sessions: [{ id: "chat-1", space_id: null, folder_id } as Session],
    activeSessionId: "chat-1",
  });
}

function folderOfChat(): string | null {
  return useChatStore.getState().sessions[0]!.folder_id;
}

describe("/folder", () => {
  beforeEach(() => {
    setSessionFolder.mockClear();
    createFolder.mockClear();
  });

  it("moves the chat into an existing folder, ignoring case", async () => {
    openChat(null);
    const outcome = await dispatch("/folder work", deps);
    expect(outcome).toMatchObject({
      result: { kind: "toast", title: "Moved to folder", body: "Work" },
    });
    expect(createFolder).not.toHaveBeenCalled();
    expect(folderOfChat()).toBe("work");
  });

  it("creates a folder rather than guessing from a partial name", async () => {
    openChat(null);
    const outcome = await dispatch("/folder Wor", deps);
    expect(outcome).toMatchObject({
      result: { kind: "toast", title: "Created folder", body: "Wor" },
    });
    expect(createFolder).toHaveBeenCalledWith("Wor");
    expect(folderOfChat()).toBe("new-folder");
  });

  it("none takes the chat out of its folder", async () => {
    openChat("work");
    const outcome = await dispatch("/folder none", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Removed from folder" } });
    expect(setSessionFolder).toHaveBeenCalledWith({ id: "chat-1", folder_id: null });
    expect(folderOfChat()).toBeNull();
  });
});
