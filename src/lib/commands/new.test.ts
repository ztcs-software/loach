// `/new` on a Space's page: the composer there has no chat yet, so Library
// picks made in it wait for one. A send hands them to the chat it creates;
// `/new` didn't, and they attached to whichever chat came next instead.

import { describe, it, expect, vi } from "vitest";
import type { Space } from "@/types";
import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSpaceStore } from "@/stores/spaceStore";

const deps = { confirm: async () => true };

describe("/new on a Space's page", () => {
  it("gives the new chat the Library picks made there", async () => {
    useChatStore.setState({ sessions: [], activeSessionId: null });
    useSpaceStore.setState({
      spaces: [{ id: "space-1", name: "Work" } as Space],
      viewingSpaceId: "space-1",
      activeSpaceId: "space-1",
    });
    const addSources = vi.fn(async () => {});
    useLibraryStore.setState({
      pending: { itemIds: ["item-1"], datasetIds: ["set-1"], spaceId: "space-1" },
      addSources,
    });

    const outcome = await dispatch("/new", deps);

    expect(outcome).toMatchObject({ result: { kind: "toast", title: "New chat" } });
    const created = useChatStore.getState().activeSessionId;
    expect(created).toBeTruthy();
    expect(addSources).toHaveBeenCalledWith("session", created, {
      itemIds: ["item-1"],
      datasetIds: ["set-1"],
    });
    expect(useLibraryStore.getState().pending).toEqual({
      itemIds: [],
      datasetIds: [],
      spaceId: null,
    });
    expect(useSpaceStore.getState().viewingSpaceId).toBeNull();
  });
});
