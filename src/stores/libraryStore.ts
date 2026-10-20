import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  libraryAddLink,
  libraryAddSources,
  libraryCreateDataset,
  libraryCreateItem,
  libraryDeleteDataset,
  libraryDeleteItems,
  libraryGetItems,
  libraryList,
  libraryListSources,
  libraryRefreshLink,
  libraryRemoveSource,
  libraryRenameItem,
  librarySetDatasetItems,
  librarySetSourceEnabled,
  libraryUpdateDataset,
  libraryUpdateText,
  onIndexStatus,
  ragStatus,
} from "@/lib/tauri";
import { fileToAttachment, NO_DOCX_TEXT, NO_PDF_TEXT } from "@/lib/files";
import { useToastStore } from "./toastStore";
import type {
  IndexStatus,
  LibraryDataset,
  LibraryItem,
  LibraryItemMeta,
  LibrarySource,
  LibrarySourceOwner,
} from "@/types";

/** A file read and extracted, ready to become a Library item. */
export interface PreparedFile {
  name: string;
  mime: string;
  media: "text" | "image";
  content: string;
  size: number;
  truncated: boolean;
  hash: string;
}

/** Lowercase hex SHA-256 of `text`, matching `db::library::content_hash`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read files the way the composer does (PDF / Word text extraction, images
 *  as base64). Files the model couldn't read are reported, not stored. */
export async function prepareFiles(
  files: File[],
): Promise<{ ready: PreparedFile[]; failed: { name: string; reason: string }[] }> {
  const ready: PreparedFile[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const file of files) {
    try {
      const att = await fileToAttachment(file);
      if (att.kind === "file") {
        failed.push({
          name: file.name,
          reason: "not a format Loach can read (text, code, PDF, Word or image)",
        });
        continue;
      }
      // A scanned PDF or an empty document comes back as a fixed note, which
      // every such file shares — stored, it'd be a "source" with nothing in
      // it, and the next one would look like a duplicate.
      if (att.kind === "text" && (att.data === NO_PDF_TEXT || att.data === NO_DOCX_TEXT || !att.data.trim())) {
        failed.push({
          name: file.name,
          reason:
            att.data === NO_PDF_TEXT
              ? "no readable text — it may be a scanned PDF. Add its pages as images, or a text version, instead."
              : "no readable text",
        });
        continue;
      }
      ready.push({
        name: file.name,
        mime: att.mime,
        media: att.kind === "image" ? "image" : "text",
        content: att.data,
        size: file.size,
        truncated: !!att.truncated,
        hash: await sha256Hex(att.data),
      });
    } catch (e) {
      failed.push({ name: file.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ready, failed };
}

const ownerKey = (owner: LibrarySourceOwner, ownerId: string) => `${owner}:${ownerId}`;

/** `added` in front of `list`, without a second copy of any of them — a
 *  refresh landing first may already have brought them in. */
function withNew<T extends { id: string }>(list: T[], added: T[]): T[] {
  const ids = new Set(added.map((x) => x.id));
  return [...added, ...list.filter((x) => !ids.has(x.id))];
}

/** Rows in `local` that a list fetched at `since` couldn't have known about. */
function createdSince<T extends { id: string; created_at: number }>(local: T[], fetched: T[], since: number): T[] {
  const ids = new Set(fetched.map((x) => x.id));
  return local.filter((x) => !ids.has(x.id) && x.created_at >= since);
}

/** Bodies already fetched, keyed by id and valid while `updated_at` matches.
 *  The send path asks for the same sources every turn; this keeps them from
 *  crossing IPC again until one is edited. */
const contentCache = new Map<string, LibraryItem>();

/** Per-owner version of the cached link lists. Every change bumps it, so a
 *  list read before the change can't land after it and undo it. */
const sourceVersions = new Map<string, number>();
const bumpSources = (key: string) => {
  const v = (sourceVersions.get(key) ?? 0) + 1;
  sourceVersions.set(key, v);
  return v;
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface LibraryState {
  items: LibraryItemMeta[];
  datasets: LibraryDataset[];
  hydrated: boolean;
  error: string | null;
  indexStatus: IndexStatus | null;
  /** Links into Spaces and chats, keyed `space:<id>` / `session:<id>`.
   *  Loaded on demand by whoever needs them. */
  sources: Record<string, LibrarySource[]>;
  /** Item shown in the preview dialog, from any surface. */
  previewItemId: string | null;
  /** Text item open in the editor dialog, or "new". */
  editTextTarget: string | null;
  /** The editor's unsaved title and body. Kept here, not in the dialog: the
   *  app lock unmounts the dialog, and a long draft must still be there when
   *  it comes back. Dropped on save or close. */
  editDraft: { target: string; title: string; body: string } | null;
  /** Dataset the Library page is showing as its own page — the Library's
   *  `spaceStore.viewingSpaceId`. Null shows the Library list. */
  viewingDatasetId: string | null;
  /** Sources picked in the composer before its chat exists (the welcome
   *  screen, a Space's page), and the Space — or none — that chat will be in.
   *  Only the composer's own send links them, to the chat it creates in that
   *  Space; a chat started any other way never picks them up. */
  pending: { itemIds: string[]; datasetIds: string[]; spaceId: string | null };

  hydrate: () => Promise<void>;
  refreshItems: () => Promise<void>;
  createText: (title: string, content: string) => Promise<LibraryItemMeta>;
  updateText: (id: string, title: string, content: string) => Promise<void>;
  /** Store already-prepared files. Returns the new items. */
  addPrepared: (files: PreparedFile[]) => Promise<LibraryItemMeta[]>;
  addLink: (url: string) => Promise<LibraryItemMeta>;
  refreshLink: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  /** False when the delete failed (a toast already said why). */
  deleteItems: (ids: string[]) => Promise<boolean>;
  createDataset: (name: string, description: string, itemIds?: string[]) => Promise<LibraryDataset>;
  updateDataset: (id: string, name: string, description: string) => Promise<void>;
  setDatasetItems: (id: string, itemIds: string[]) => Promise<void>;
  addToDataset: (id: string, itemIds: string[]) => Promise<void>;
  deleteDataset: (id: string) => Promise<void>;
  /** Save a body from elsewhere (an attachment, a Space file, a reply).
   *  Skips — with a toast — when the same body is already stored. */
  saveToLibrary: (args: {
    kind: "text" | "file";
    title: string;
    mime: string;
    media: "text" | "image";
    content: string;
    size: number;
  }) => Promise<LibraryItemMeta | null>;

  loadSources: (owner: LibrarySourceOwner, ownerId: string) => Promise<LibrarySource[]>;
  ensureSources: (owner: LibrarySourceOwner, ownerId: string) => Promise<LibrarySource[]>;
  addSources: (
    owner: LibrarySourceOwner,
    ownerId: string,
    refs: { itemIds: string[]; datasetIds: string[] },
  ) => Promise<void>;
  removeSource: (owner: LibrarySourceOwner, ownerId: string, sourceId: string) => Promise<void>;
  setSourceEnabled: (
    owner: LibrarySourceOwner,
    ownerId: string,
    sourceId: string,
    enabled: boolean,
  ) => Promise<void>;

  /** Full bodies for `ids`, served from cache where still current. */
  getContents: (ids: string[]) => Promise<LibraryItem[]>;
  openPreview: (id: string | null) => void;
  openTextEditor: (target: string | null) => void;
  /** Park sources for the chat the composer will create in `spaceId`.
   *  Picks parked for a different Space are dropped. */
  addPending: (sel: { itemIds: string[]; datasetIds: string[] }, spaceId: string | null) => void;
  removePending: (id: string) => void;
  /** Take (and clear) the pending sources — none unless they were picked
   *  for a chat in `spaceId`. */
  consumePending: (spaceId: string | null) => { itemIds: string[]; datasetIds: string[] };
  setViewingDataset: (id: string | null) => void;
}

let unlistenIndex: (() => void) | null = null;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  items: [],
  datasets: [],
  hydrated: false,
  error: null,
  indexStatus: null,
  sources: {},
  previewItemId: null,
  editTextTarget: null,
  editDraft: null,
  viewingDatasetId: null,
  pending: { itemIds: [], datasetIds: [], spaceId: null },

  hydrate: async () => {
    try {
      const { items, datasets } = await libraryList();
      set({ items, datasets, hydrated: true, error: null });
      // A fresh hydrate (startup, or after an import rewrote the tables)
      // invalidates every cached link list and body.
      contentCache.clear();
      sourceVersions.clear();
      set({ sources: {} });
    } catch (e) {
      logger.error("library hydrate failed", e);
      set({ hydrated: true, error: errorText(e) });
    }
    if (!unlistenIndex) {
      // When a pass of the indexer settles, the per-item embedded counts in
      // the list are stale — re-read them.
      void onIndexStatus((status) => {
        const was = get().indexStatus;
        set({ indexStatus: status });
        if (was?.busy && !status.busy) void get().refreshItems();
      }).then((u) => {
        unlistenIndex = u;
      });
      void ragStatus()
        .then((status) => set((s) => ({ indexStatus: s.indexStatus ?? status })))
        .catch(() => undefined);
    }
  },

  refreshItems: async () => {
    // Writes can land while the list is in flight — an upload finishing,
    // say. Rows created since it was asked for are kept rather than wiped,
    // and the server's copy wins for everything else.
    const since = Date.now();
    try {
      const { items, datasets } = await libraryList();
      set((s) => ({
        items: [...createdSince(s.items, items, since), ...items],
        datasets: [...createdSince(s.datasets, datasets, since), ...datasets],
      }));
    } catch (e) {
      logger.warn("library refresh failed", e);
    }
  },

  createText: async (title, content) => {
    const item = await libraryCreateItem({
      kind: "text",
      title,
      mime: "text/markdown",
      media: "text",
      content,
      size: new TextEncoder().encode(content).length,
    });
    set((s) => ({ items: withNew(s.items, [item]) }));
    return item;
  },

  updateText: async (id, title, content) => {
    const item = await libraryUpdateText({ id, title, content });
    contentCache.delete(id);
    set((s) => ({ items: s.items.map((i) => (i.id === id ? item : i)) }));
  },

  addPrepared: async (files) => {
    const added: LibraryItemMeta[] = [];
    for (const f of files) {
      try {
        added.push(
          await libraryCreateItem({
            kind: "file",
            title: f.name,
            mime: f.mime,
            media: f.media,
            content: f.content,
            size: f.size,
            truncated: f.truncated,
          }),
        );
      } catch (e) {
        useToastStore.getState().push({
          kind: "error",
          title: `Couldn't add ${f.name}`,
          body: errorText(e),
        });
      }
    }
    if (added.length > 0) set((s) => ({ items: withNew(s.items, [...added].reverse()) }));
    return added;
  },

  addLink: async (url) => {
    const item = await libraryAddLink(url);
    set((s) => ({ items: withNew(s.items, [item]) }));
    return item;
  },

  refreshLink: async (id) => {
    try {
      const item = await libraryRefreshLink(id);
      contentCache.delete(id);
      set((s) => ({ items: s.items.map((i) => (i.id === id ? item : i)) }));
      useToastStore.getState().push({ kind: "info", title: "Link refreshed" });
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't refresh the link",
        body: errorText(e),
      });
    }
  },

  rename: async (id, title) => {
    // The server's row, not a local `Date.now()`: `getContents` keys its
    // cache on `updated_at`, and a client timestamp would never match it.
    const item = await libraryRenameItem(id, title);
    contentCache.delete(id);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? (item ?? { ...i, title }) : i)),
    }));
  },

  deleteItems: async (ids) => {
    try {
      await libraryDeleteItems(ids);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't delete",
        body: errorText(e),
      });
      return false;
    }
    const gone = new Set(ids);
    ids.forEach((id) => contentCache.delete(id));
    set((s) => ({
      items: s.items.filter((i) => !gone.has(i.id)),
      datasets: s.datasets.map((d) => ({
        ...d,
        item_ids: d.item_ids.filter((id) => !gone.has(id)),
      })),
      // Links cascade away in the database; mirror that.
      sources: Object.fromEntries(
        Object.entries(s.sources).map(([k, list]) => [
          k,
          list.filter((src) => !src.item_id || !gone.has(src.item_id)),
        ]),
      ),
      previewItemId: s.previewItemId && gone.has(s.previewItemId) ? null : s.previewItemId,
    }));
    return true;
  },

  createDataset: async (name, description, itemIds = []) => {
    const ds = await libraryCreateDataset({ name, description, itemIds });
    set((s) => ({ datasets: withNew(s.datasets, [ds]) }));
    return ds;
  },

  updateDataset: async (id, name, description) => {
    await libraryUpdateDataset({ id, name, description });
    const now = Date.now();
    set((s) => ({
      datasets: s.datasets.map((d) =>
        d.id === id ? { ...d, name, description, updated_at: now } : d,
      ),
    }));
  },

  setDatasetItems: async (id, itemIds) => {
    const stored = await librarySetDatasetItems(id, itemIds);
    const now = Date.now();
    set((s) => ({
      datasets: s.datasets.map((d) =>
        d.id === id ? { ...d, item_ids: stored, updated_at: now } : d,
      ),
    }));
  },

  addToDataset: async (id, itemIds) => {
    const ds = get().datasets.find((d) => d.id === id);
    if (!ds) return;
    const next = [...ds.item_ids, ...itemIds.filter((i) => !ds.item_ids.includes(i))];
    await get().setDatasetItems(id, next);
  },

  deleteDataset: async (id) => {
    try {
      await libraryDeleteDataset(id);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't delete dataset",
        body: errorText(e),
      });
      return;
    }
    set((s) => ({
      datasets: s.datasets.filter((d) => d.id !== id),
      sources: Object.fromEntries(
        Object.entries(s.sources).map(([k, list]) => [
          k,
          list.filter((src) => src.dataset_id !== id),
        ]),
      ),
    }));
  },

  saveToLibrary: async (args) => {
    const hash = await sha256Hex(args.content);
    const existing = get().items.find((i) => i.content_hash === hash);
    if (existing) {
      useToastStore.getState().push({
        kind: "info",
        title: "Already in your Library",
        body: `Saved as “${existing.title}”.`,
      });
      return null;
    }
    try {
      const item = await libraryCreateItem(args);
      set((s) => ({ items: withNew(s.items, [item]) }));
      useToastStore.getState().push({
        kind: "info",
        title: "Saved to Library",
        body: item.title,
      });
      return item;
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save to Library",
        body: errorText(e),
      });
      return null;
    }
  },

  loadSources: async (owner, ownerId) => {
    const key = ownerKey(owner, ownerId);
    const version = bumpSources(key);
    const list = await libraryListSources(owner, ownerId);
    // Superseded while in flight (a source added, removed or toggled, or a
    // later load): the store already holds something newer.
    if (sourceVersions.get(key) !== version) return get().sources[key] ?? list;
    set((s) => ({ sources: { ...s.sources, [key]: list } }));
    return list;
  },

  ensureSources: async (owner, ownerId) => {
    const cached = get().sources[ownerKey(owner, ownerId)];
    return cached ?? get().loadSources(owner, ownerId);
  },

  addSources: async (owner, ownerId, refs) => {
    const list = await libraryAddSources({ owner, ownerId, ...refs });
    const key = ownerKey(owner, ownerId);
    bumpSources(key);
    set((s) => ({ sources: { ...s.sources, [key]: list } }));
  },

  removeSource: async (owner, ownerId, sourceId) => {
    try {
      await libraryRemoveSource(owner, sourceId);
    } catch (e) {
      useToastStore.getState().push({ kind: "error", title: "Couldn't remove the source", body: errorText(e) });
      return;
    }
    const key = ownerKey(owner, ownerId);
    bumpSources(key);
    set((s) => ({
      sources: {
        ...s.sources,
        [key]: (s.sources[key] ?? []).filter((src) => src.id !== sourceId),
      },
    }));
  },

  setSourceEnabled: async (owner, ownerId, sourceId, enabled) => {
    try {
      await librarySetSourceEnabled(owner, sourceId, enabled);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: enabled ? "Couldn't switch the source on" : "Couldn't switch the source off",
        body: errorText(e),
      });
      return;
    }
    const key = ownerKey(owner, ownerId);
    bumpSources(key);
    set((s) => ({
      sources: {
        ...s.sources,
        [key]: (s.sources[key] ?? []).map((src) =>
          src.id === sourceId ? { ...src, enabled } : src,
        ),
      },
    }));
  },

  getContents: async (ids) => {
    const metas = new Map(get().items.map((i) => [i.id, i]));
    const missing = ids.filter((id) => {
      const hit = contentCache.get(id);
      return !hit || hit.updated_at !== metas.get(id)?.updated_at;
    });
    if (missing.length > 0) {
      for (const item of await libraryGetItems(missing)) contentCache.set(item.id, item);
    }
    return ids.map((id) => contentCache.get(id)).filter((i): i is LibraryItem => !!i);
  },

  openPreview: (id) => set({ previewItemId: id }),
  openTextEditor: (target) =>
    set((s) => ({
      editTextTarget: target,
      editDraft: target !== null && s.editDraft?.target === target ? s.editDraft : null,
    })),
  addPending: (sel, spaceId) =>
    set((s) => {
      const kept = s.pending.spaceId === spaceId ? s.pending : { itemIds: [], datasetIds: [] };
      return {
        pending: {
          itemIds: [...new Set([...kept.itemIds, ...sel.itemIds])],
          datasetIds: [...new Set([...kept.datasetIds, ...sel.datasetIds])],
          spaceId,
        },
      };
    }),
  removePending: (id) =>
    set((s) => ({
      pending: {
        ...s.pending,
        itemIds: s.pending.itemIds.filter((x) => x !== id),
        datasetIds: s.pending.datasetIds.filter((x) => x !== id),
      },
    })),
  consumePending: (spaceId) => {
    const { itemIds, datasetIds, spaceId: pickedFor } = get().pending;
    set({ pending: { itemIds: [], datasetIds: [], spaceId: null } });
    return pickedFor === spaceId ? { itemIds, datasetIds } : { itemIds: [], datasetIds: [] };
  },
  setViewingDataset: (id) => set({ viewingDatasetId: id }),
}));

/** Resolve an owner's links into the distinct, enabled items they reach —
 *  datasets expanded in order, an item reached twice counted once. */
export function expandSources(
  sources: LibrarySource[],
  datasets: LibraryDataset[],
  items: LibraryItemMeta[],
): LibraryItemMeta[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const dsById = new Map(datasets.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const out: LibraryItemMeta[] = [];
  const push = (id: string) => {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      seen.add(id);
      out.push(item);
    }
  };
  for (const src of sources) {
    if (!src.enabled) continue;
    if (src.item_id) push(src.item_id);
    else if (src.dataset_id) dsById.get(src.dataset_id)?.item_ids.forEach(push);
  }
  return out;
}
