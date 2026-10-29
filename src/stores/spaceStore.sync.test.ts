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
//   - The context a send reads: one read before a memory was added landed
//     after it, and was cached — and sent — without the memory.
//   - Saving a Space: two saves at once each filled the fields they weren't
//     given from before the other landed, and wrote the old values back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, SpaceContext, SpaceFile, SpaceMemory } from "@/types";

const mocks = vi.hoisted(() => ({
  /** What the backend holds for the Space's sources. */
  files: [] as SpaceFile[],
  /** …and for its memories. */
  memories: [] as SpaceMemory[],
  /** When set, the next listing parks with the rows it read at call time. */
  parkList: false,
  release: null as null | (() => void),
  /** Each `update_space` payload, in the order sent. */
  updates: [] as Array<Record<string, unknown>>,
  parkUpdate: false,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const park = <T,>(value: T): Promise<T> => {
    if (!mocks.parkList) return Promise.resolve(value);
    mocks.parkList = false;
    return new Promise((resolve) => (mocks.release = () => resolve(value)));
  };
  return {
    ...actual,
    listSpaceFiles: vi.fn(() => park(mocks.files.map((f) => ({ ...f })))),
    setSpaceFileEnabled: vi.fn(async (id: string, enabled: boolean) => {
      mocks.files = mocks.files.map((f) => (f.id === id ? { ...f, enabled } : f));
    }),
    getSpaceContext: vi.fn((spaceId: string) =>
      park({ space: { id: spaceId }, files: [], memories: [...mocks.memories] } as unknown as SpaceContext),
    ),
    addSpaceMemory: vi.fn(async (args: { space_id: string; content: string }) => {
      const memory = { id: `mem-${mocks.memories.length}`, ...args, created_at: 1 } as unknown as SpaceMemory;
      mocks.memories.push(memory);
      return memory;
    }),
    updateSpace: vi.fn((args: Record<string, unknown>) => {
      mocks.updates.push(args);
      if (!mocks.parkUpdate) return Promise.resolve();
      mocks.parkUpdate = false;
      return new Promise<void>((resolve) => (mocks.release = resolve));
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
  mocks.memories = [];
  mocks.parkList = false;
  mocks.release = null;
  mocks.updates = [];
  mocks.parkUpdate = false;
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

describe("loading a Space's context", () => {
  it("reads again when a memory lands while the context is read", async () => {
    useSpaceStore.setState({ spaceMemories: {} });
    mocks.parkList = true;
    const load = store().loadSpaceContext("ctx");
    await store().addMemory({ space_id: "ctx", content: "Prefers metric units" });
    mocks.release!();

    const ctx = await load;
    expect(ctx.memories.map((m) => m.content)).toEqual(["Prefers metric units"]);
    expect(store().spaceMemories.ctx.map((m) => m.content)).toEqual(["Prefers metric units"]);
    // …and what's cached is the fresh read, for the next send.
    expect((await store().loadSpaceContext("ctx")).memories).toHaveLength(1);
  });
});

describe("saving a Space", () => {
  it("builds each save on the one before it", async () => {
    const base = { name: "S", description: "", instructions: "" };
    useSpaceStore.setState({
      spaces: [{ id: "sp", ...base, default_provider: null, default_model: null, default_params_json: null }] as never,
    });
    mocks.parkUpdate = true;
    const first = store().updateSpace("sp", { ...base, default_params_json: '{"temperature":0.2}' });
    const second = store().updateSpace("sp", { ...base, default_model: "m" });
    await Promise.resolve();
    mocks.release!();
    await Promise.all([first, second]);

    expect(mocks.updates[1]).toMatchObject({ default_model: "m", default_params_json: '{"temperature":0.2}' });
    expect(store().spaces[0]).toMatchObject({ default_model: "m", default_params_json: '{"temperature":0.2}' });
  });
});
