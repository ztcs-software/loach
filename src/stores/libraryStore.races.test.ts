// Library store writes racing a read that's already in flight.
//
// `refreshItems` (fired when an indexer pass settles) replaced the whole item
// list with what the server had when it was asked, so an item created while
// it was in flight vanished, or showed twice once the add landed. And a slow
// `loadSources` could land after `addSources` and hide the source just added.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryItemMeta, LibrarySource } from "@/types";

const gate = vi.hoisted(() => ({
  list: null as null | ((v: unknown) => void),
  sources: null as null | ((v: unknown) => void),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    libraryList: vi.fn(() => new Promise((r) => (gate.list = r))),
    libraryListSources: vi.fn(() => new Promise((r) => (gate.sources = r))),
    libraryCreateItem: vi.fn(async () => item("new", Date.now() + 1)),
    libraryAddSources: vi.fn(async () => [link("l-new", "new")]),
  };
});

import { useLibraryStore } from "./libraryStore";

function item(id: string, created_at: number): LibraryItemMeta {
  return {
    id,
    kind: "text",
    title: id,
    mime: "text/markdown",
    media: "text",
    size: 1,
    chars: 1,
    preview: "",
    url: null,
    fetched_at: null,
    content_hash: id,
    truncated: false,
    chunks: 1,
    embedded: 0,
    created_at,
    updated_at: created_at,
  };
}

function link(id: string, itemId: string): LibrarySource {
  return { id, owner_id: "chat", item_id: itemId, dataset_id: null, enabled: true, position: 0, created_at: 0 };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const store = () => useLibraryStore.getState();

beforeEach(() => {
  gate.list = null;
  gate.sources = null;
  useLibraryStore.setState({ items: [item("old", 1)], datasets: [], sources: {} });
});

describe("library store races", () => {
  it("a refresh in flight keeps an item created meanwhile, once", async () => {
    const refresh = store().refreshItems();
    await store().createText("new", "body");
    // The refresh was read before "new" existed, so it reads again.
    gate.list!({ items: [{ ...item("old", 1), embedded: 1 }], datasets: [] });
    await tick();
    gate.list!({ items: [item("new", 2), { ...item("old", 1), embedded: 1 }], datasets: [] });
    await refresh;
    expect(store().items.map((i) => i.id)).toEqual(["new", "old"]);
    // …and the server's copy of what it did know wins.
    expect(store().items.find((i) => i.id === "old")?.embedded).toBe(1);
  });

  // An indexer pass settling fires a refresh, and a list read before a delete
  // or a rename put the deleted item back, or the old title.
  it("a refresh in flight doesn't undo a delete or a rename made meanwhile", async () => {
    useLibraryStore.setState({ items: [item("old", 1), item("gone", 1)] });
    const refresh = store().refreshItems();
    await store().deleteItems(["gone"]);
    await store().rename("old", "Renamed");
    gate.list!({ items: [item("old", 1), item("gone", 1)], datasets: [] });
    await tick();
    gate.list!({ items: [{ ...item("old", 1), title: "Renamed" }], datasets: [] });
    await refresh;
    expect(store().items.map((i) => [i.id, i.title])).toEqual([["old", "Renamed"]]);
  });

  it("overlapping additions to a dataset each build on the one before", async () => {
    useLibraryStore.setState({
      datasets: [{ id: "ds", name: "ds", description: "", item_ids: ["a"], created_at: 0, updated_at: 0 }],
    });
    await Promise.all([store().addToDataset("ds", ["b"]), store().addToDataset("ds", ["c"])]);
    expect(store().datasets[0].item_ids).toEqual(["a", "b", "c"]);
  });

  it("a refresh that already has the new item doesn't show it twice", async () => {
    const refresh = store().refreshItems();
    gate.list!({ items: [item("new", Date.now() + 1), item("old", 1)], datasets: [] });
    await refresh;
    await store().createText("new", "body");
    expect(store().items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("a slow link list doesn't undo a source added meanwhile", async () => {
    const load = store().loadSources("session", "chat");
    await tick();
    await store().addSources("session", "chat", { itemIds: ["new"], datasetIds: [] });
    gate.sources!([]); // read before the add
    expect(await load).toEqual([link("l-new", "new")]);
    expect(store().sources["session:chat"]).toEqual([link("l-new", "new")]);
  });
});
