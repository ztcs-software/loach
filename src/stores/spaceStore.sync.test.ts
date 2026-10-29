// What the frontend caches about a Space, kept in step with the database.
//
//   - Deleting a Space: the database sets its chats' `space_id` to NULL and
//     drops its Library links, but the chat list and the link cache kept
//     both — former chats went on sending the deleted Space's sources, their
//     auto-memory stopped, `/remember` failed on the missing row, and the
//     Space-sources chip opened a blank page.
//   - Loading a Space's sources: SpaceView reloads them on every visit, and a
//     list read before a switch, removal or upload landed after it and put
//     the old state back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, SpaceFile } from "@/types";

const mocks = vi.hoisted(() => ({
  /** What the backend holds for the Space's sources. */
  files: [] as SpaceFile[],
  /** When set, the next listing parks with the rows it read at call time. */
  parkList: false,
  release: null as null | (() => void),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    listSpaceFiles: vi.fn(() => {
      const read = mocks.files.map((f) => ({ ...f }));
      if (!mocks.parkList) return Promise.resolve(read);
      mocks.parkList = false;
      return new Promise((resolve) => (mocks.release = () => resolve(read)));
    }),
    setSpaceFileEnabled: vi.fn(async (id: string, enabled: boolean) => {
      mocks.files = mocks.files.map((f) => (f.id === id ? { ...f, enabled } : f));
    }),
  };
});

import { useSpaceStore } from "./spaceStore";
import { useChatStore } from "./chatStore";
import { useLibraryStore } from "./libraryStore";

const store = () => useSpaceStore.getState();

const chat = (id: string, spaceId: string | null) => ({ id, space_id: spaceId }) as Session;
const file = (id: string): SpaceFile =>
  ({ id, space_id: "sp", name: id, mime: "text/plain", kind: "text", data: "x", size: 1, position: 0, enabled: true, created_at: 0 }) as SpaceFile;

beforeEach(() => {
  mocks.files = [];
  mocks.parkList = false;
  mocks.release = null;
});

describe("deleting a Space", () => {
  it("mirrors what the database did to its chats, its links and the view", async () => {
    useSpaceStore.setState({
      spaces: [{ id: "sp" }, { id: "other" }] as never,
      activeSpaceId: "sp",
      viewingSpaceId: "sp",
    });
    useChatStore.setState({ sessions: [chat("a", "sp"), chat("b", "other"), chat("c", null)] });
    useLibraryStore.setState({ sources: { "space:sp": [], "space:other": [], "session:a": [] } });

    expect(await store().deleteSpace("sp")).toBe(true);

    expect(useChatStore.getState().sessions.map((s) => s.space_id)).toEqual([null, "other", null]);
    expect(Object.keys(useLibraryStore.getState().sources)).toEqual(["space:other", "session:a"]);
    expect(store().activeSpaceId).toBeNull();
    expect(store().viewingSpaceId).toBeNull();
  });
});

describe("loading a Space's sources", () => {
  it("doesn't let a list read before a switch undo it", async () => {
    mocks.files = [file("f1")];
    useSpaceStore.setState({ spaceFiles: { sp: [file("f1")] } });

    mocks.parkList = true;
    const load = store().loadSpaceFiles("sp");
    await store().setFileEnabled("f1", "sp", false);
    mocks.release!();
    await load;

    expect(store().spaceFiles.sp.map((f) => f.enabled)).toEqual([false]);
  });
});
