import { create } from "zustand";
import { logger } from "@/lib/logger";
import { useToastStore } from "./toastStore";
import {
  addSpaceFile,
  addSpaceMemory,
  createSpace,
  deleteSpace,
  getSpaceContext,
  listSpaceFiles,
  listSpaceMemories,
  listSpaces,
  removeSpaceFile,
  removeSpaceMemory,
  setSpaceFileEnabled,
  setSpaceImageScaling,
  setSpaceRetrievalMode,
  updateSpace,
  updateSpaceMemory,
} from "@/lib/tauri";
import { SPACE_BYTES_CAP } from "@/lib/files";
import {
  getCachedSpaceContext,
  invalidateSpaceContext as dropCachedContext,
  invalidateAllSpaceContext,
  setCachedSpaceContext,
} from "@/lib/spaceContextCache";
import type { ImageScaling, RetrievalMode, Space, SpaceContext, SpaceFile, SpaceMemory } from "@/types";
import { useChatStore } from "./chatStore";
import { useLibraryStore } from "./libraryStore";

/** The tabs of a Space's page. `files` is the Sources tab. */
export type SpaceTab = "chats" | "instructions" | "files" | "memory" | "settings";

interface SpaceState {
  spaces: Space[];
  activeSpaceId: string | null;
  viewingSpaceId: string | null;
  /** The tab each Space's page was last left on, by space id — so coming back
   *  to a Space (from one of its chats, say) lands where the user was, the
   *  way the Library keeps its tab. In memory only: a Space not opened yet
   *  this run starts on Chats. */
  spaceTabs: Record<string, SpaceTab>;
  spaceFiles: Record<string, SpaceFile[]>;
  /** Per-space memory cache, keyed by `space_id`. Hydrated lazily — the
   *  Memory tab and the chat send path each call `loadSpaceMemories` when
   *  they need it. Mutated directly by the extractor when it auto-saves a
   *  new row so the Memory tab reflects writes without a re-fetch. */
  spaceMemories: Record<string, SpaceMemory[]>;
  spaceFormOpen: boolean;
  /** Set true once `hydrate()` has run (success or failure) so the library can
   *  distinguish "still loading" from "genuinely empty". */
  hydrated: boolean;
  /** Non-null when the last hydrate failed — drives the library's retry UI. */
  error: string | null;

  hydrate: () => Promise<void>;
  selectSpace: (id: string | null) => void;
  createSpace: (
    name: string,
    description: string,
    instructions: string,
  ) => Promise<Space>;
  updateSpace: (
    id: string,
    fields: {
      name: string;
      description: string;
      instructions: string;
      default_provider?: string | null;
      default_model?: string | null;
      default_params_json?: string | null;
      memory_enabled?: boolean | null;
    },
  ) => Promise<void>;
  /** Resolves `true` when the row was deleted, `false` when the delete
   *  failed (a toast is shown in that case). Callers that navigate on
   *  success — e.g. SpaceView returning to the library — should gate on it. */
  deleteSpace: (id: string) => Promise<boolean>;
  setSpaceFormOpen: (open: boolean) => void;
  /** Open a Space's page — on `tab` when given (a link straight to its
   *  Sources, say), else on the tab it was last left on. */
  setViewingSpace: (id: string | null, tab?: SpaceTab) => void;
  setSpaceTab: (id: string, tab: SpaceTab) => void;

  loadSpaceFiles: (spaceId: string) => Promise<SpaceFile[]>;
  addFile: (
    spaceId: string,
    name: string,
    mime: string,
    kind: string,
    data: string,
    size: number,
  ) => Promise<SpaceFile>;
  removeFile: (fileId: string, spaceId: string) => Promise<void>;
  /** Keep a source in the Space but out of (or back into) its chats. */
  setFileEnabled: (fileId: string, spaceId: string, enabled: boolean) => Promise<void>;
  /** How the Space's sources reach the model. */
  setRetrievalMode: (spaceId: string, mode: RetrievalMode) => Promise<void>;
  /** How images are scaled for the Space's chats; `null` inherits the app's. */
  setImageScaling: (spaceId: string, scaling: ImageScaling | null) => Promise<void>;

  loadSpaceMemories: (spaceId: string) => Promise<SpaceMemory[]>;
  /** The context a send in the Space reads — instructions, sources and
   *  memories — cached until a write changes it. Its memories also refresh
   *  `spaceMemories`. */
  loadSpaceContext: (spaceId: string) => Promise<SpaceContext>;
  /** Insert a new memory and return the persisted row. Used by both the
   *  extractor (auto-save) and the Memory tab's "Add manually" affordance.
   *  Source ids are optional so manual entries leave both NULL. */
  addMemory: (args: {
    space_id: string;
    content: string;
    source_session_id?: string | null;
    source_message_id?: string | null;
    restore_id?: string;
    restore_created_at?: number;
  }) => Promise<SpaceMemory>;
  /** `false` when the memory was already gone. */
  updateMemory: (id: string, spaceId: string, content: string) => Promise<boolean>;
  /** `false` when the memory was already gone. */
  removeMemory: (id: string, spaceId: string) => Promise<boolean>;
}

/** Memory writes completed so far. A load compares it before and after
 *  reading: a write that finished in between may be missing from what it
 *  read, while the write itself skipped the not-yet-loaded cache — so it
 *  reads again. */
let memoryWrites = 0;

/** The same for a Space's sources: SpaceView reloads them on every visit,
 *  and a list read before an upload, removal or switch landed after it and
 *  put the old state back. */
let fileWrites = 0;

/** And for the context a send reads (instructions, sources, memories): a
 *  read already under way when a write dropped the cached copy used to be
 *  cached in its place, and sent until the next write. */
let contextWrites = 0;

function invalidateSpaceContext(spaceId: string) {
  contextWrites++;
  dropCachedContext(spaceId);
}

/** Each Space's `updateSpace` calls, run one after another. A call fills the
 *  fields it isn't given from the Space as it stands, and built at once, a
 *  later save took them from before an earlier one landed — and wrote the
 *  old values back over it. */
const spaceUpdates = new Map<string, Promise<void>>();

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  activeSpaceId: null,
  viewingSpaceId: null,
  spaceTabs: {},
  spaceFiles: {},
  spaceMemories: {},
  spaceFormOpen: false,
  hydrated: false,
  error: null,

  hydrate: async () => {
    try {
      const spaces = await listSpaces();
      set({ spaces, hydrated: true, error: null });
      // A fresh hydrate (startup, or after a data import rewrote the spaces
      // tables) means any previously-cached context may be stale.
      contextWrites++;
      invalidateAllSpaceContext();
    } catch (e) {
      logger.error("space hydrate failed", e);
      set({
        hydrated: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  selectSpace: (id) => {
    set({ activeSpaceId: id });
  },

  createSpace: async (name, description, instructions) => {
    const space = await createSpace({ name, description, instructions });
    set((s) => ({ spaces: [space, ...s.spaces] }));
    return space;
  },

  updateSpace: (id, fields) => {
    const run = async () => {
      // Snapshot the current row so callers can pass a partial set of fields
      // (e.g. just the name, just the model) without clobbering the rest —
      // taken once the previous save has landed (see `spaceUpdates`).
      const current = get().spaces.find((s) => s.id === id);
      const next = {
        name: fields.name,
        description: fields.description,
        instructions: fields.instructions,
        default_provider:
          fields.default_provider !== undefined
            ? fields.default_provider
            : current?.default_provider ?? null,
        default_model:
          fields.default_model !== undefined
            ? fields.default_model
            : current?.default_model ?? null,
        default_params_json:
          fields.default_params_json !== undefined
            ? fields.default_params_json
            : current?.default_params_json ?? null,
        // memory_enabled is a tri-state at the *call* layer (`undefined` =
        // "don't touch the existing value"). On the wire, Rust's
        // `Option<bool>` collapses `null` and missing key both to `None`,
        // so passing `undefined` and `null` are functionally equivalent
        // for skipping the column. We pass `undefined` to make the intent
        // explicit and to avoid the earlier "passes null but the comment
        // says undefined" mismatch that existed here.
        memory_enabled:
          fields.memory_enabled !== undefined ? fields.memory_enabled : undefined,
      };
      await updateSpace({ id, ...next });
      invalidateSpaceContext(id);
      set((s) => ({
        spaces: s.spaces.map((sp) =>
          sp.id === id
            ? {
                ...sp,
                name: next.name,
                description: next.description,
                instructions: next.instructions,
                default_provider: (next.default_provider as Space["default_provider"]) ?? null,
                default_model: next.default_model,
                default_params_json: next.default_params_json,
                // Mirror only when the caller actually supplied a value.
                // `fields.memory_enabled?: boolean | null`, so we have to
                // treat both `null` and `undefined` as "no change" to keep
                // the Space.memory_enabled invariant of `boolean` (never
                // null in the local mirror).
                memory_enabled:
                  next.memory_enabled !== null && next.memory_enabled !== undefined
                    ? next.memory_enabled
                    : sp.memory_enabled,
                updated_at: Date.now(),
              }
            : sp,
        ),
      }));
    };
    const prev = spaceUpdates.get(id);
    // After the previous save, whether or not it failed.
    const queued = prev ? prev.then(run, run) : run();
    spaceUpdates.set(id, queued);
    return queued;
  },

  deleteSpace: async (id) => {
    try {
      await deleteSpace(id);
      invalidateSpaceContext(id);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't delete space",
        body: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
    set((s) => {
      const spaces = s.spaces.filter((sp) => sp.id !== id);
      const files = { ...s.spaceFiles };
      delete files[id];
      const memories = { ...s.spaceMemories };
      delete memories[id];
      return {
        spaces,
        spaceFiles: files,
        spaceMemories: memories,
        activeSpaceId: s.activeSpaceId === id ? null : s.activeSpaceId,
        viewingSpaceId: s.viewingSpaceId === id ? null : s.viewingSpaceId,
      };
    });
    // Mirror the backend locally, like `removeFolder`: the Space's chats are
    // space-less now (ON DELETE SET NULL) and its Library links are gone
    // (CASCADE). Left cached, its former chats kept sending its sources,
    // stopped remembering anything, and failed `/remember` on the missing row.
    useChatStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.space_id === id ? { ...x, space_id: null } : x)),
    }));
    useLibraryStore.setState((s) => {
      const sources = { ...s.sources };
      delete sources[`space:${id}`];
      return { sources };
    });
    return true;
  },

  setSpaceFormOpen: (open) => set({ spaceFormOpen: open }),
  setViewingSpace: (id, tab) =>
    set((s) => ({
      viewingSpaceId: id,
      activeSpaceId: id,
      spaceTabs: id && tab ? { ...s.spaceTabs, [id]: tab } : s.spaceTabs,
    })),

  setSpaceTab: (id, tab) => set((s) => ({ spaceTabs: { ...s.spaceTabs, [id]: tab } })),

  loadSpaceFiles: async (spaceId) => {
    for (;;) {
      const before = fileWrites;
      const files = await listSpaceFiles(spaceId);
      if (fileWrites === before) {
        set((s) => ({ spaceFiles: { ...s.spaceFiles, [spaceId]: files } }));
        return files;
      }
    }
  },

  addFile: async (spaceId, name, mime, kind, data, size) => {
    const existing = get().spaceFiles[spaceId] ?? [];
    const used = existing.reduce((acc, f) => acc + f.size, 0);
    if (used + size > SPACE_BYTES_CAP) {
      throw new Error(
        `Adding "${name}" would exceed the 200 MB space limit.`,
      );
    }
    const file = await addSpaceFile({
      space_id: spaceId,
      name,
      mime,
      kind,
      data,
      size,
      position: existing.length,
    });
    fileWrites++;
    invalidateSpaceContext(spaceId);
    set((s) => ({
      spaceFiles: {
        ...s.spaceFiles,
        [spaceId]: [...(s.spaceFiles[spaceId] ?? []), file],
      },
    }));
    return file;
  },

  removeFile: async (fileId, spaceId) => {
    try {
      await removeSpaceFile(fileId);
      fileWrites++;
      invalidateSpaceContext(spaceId);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't remove source",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    set((s) => ({
      spaceFiles: {
        ...s.spaceFiles,
        [spaceId]: (s.spaceFiles[spaceId] ?? []).filter((f) => f.id !== fileId),
      },
    }));
  },

  setFileEnabled: async (fileId, spaceId, enabled) => {
    try {
      await setSpaceFileEnabled(fileId, enabled);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: enabled ? "Couldn't switch the source on" : "Couldn't switch the source off",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    fileWrites++;
    invalidateSpaceContext(spaceId);
    set((s) => ({
      spaceFiles: {
        ...s.spaceFiles,
        [spaceId]: (s.spaceFiles[spaceId] ?? []).map((f) =>
          f.id === fileId ? { ...f, enabled } : f,
        ),
      },
    }));
  },

  setRetrievalMode: async (spaceId, mode) => {
    try {
      await setSpaceRetrievalMode(spaceId, mode);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't change how sources are used",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    invalidateSpaceContext(spaceId);
    set((s) => ({
      spaces: s.spaces.map((sp) => (sp.id === spaceId ? { ...sp, retrieval_mode: mode } : sp)),
    }));
  },

  setImageScaling: async (spaceId, scaling) => {
    const json = scaling ? JSON.stringify(scaling) : null;
    try {
      await setSpaceImageScaling(spaceId, json);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't change image scaling",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    invalidateSpaceContext(spaceId);
    set((s) => ({
      spaces: s.spaces.map((sp) => (sp.id === spaceId ? { ...sp, image_scaling_json: json } : sp)),
    }));
  },

  loadSpaceMemories: async (spaceId) => {
    for (;;) {
      const before = memoryWrites;
      const memories = await listSpaceMemories(spaceId);
      if (memoryWrites === before) {
        set((s) => ({ spaceMemories: { ...s.spaceMemories, [spaceId]: memories } }));
        return memories;
      }
    }
  },

  loadSpaceContext: async (spaceId) => {
    let ctx = getCachedSpaceContext(spaceId);
    while (!ctx) {
      const before = contextWrites;
      const read = await getSpaceContext(spaceId);
      if (contextWrites === before) {
        setCachedSpaceContext(spaceId, read);
        ctx = read;
      }
    }
    // No await since the context was read or found cached, and every memory
    // write drops the cached copy — so these are current.
    const { memories } = ctx;
    set((s) => ({ spaceMemories: { ...s.spaceMemories, [spaceId]: memories } }));
    return ctx;
  },

  // The memory writes patch a Space's cached list only once it has been
  // loaded: seeding an unloaded one with a single row would make the
  // extractor (which reads the cache first) see that row as the whole list.
  addMemory: async (args) => {
    const memory = await addSpaceMemory(args);
    memoryWrites++;
    invalidateSpaceContext(args.space_id);
    set((s) => {
      const list = s.spaceMemories[args.space_id];
      if (!list) return s;
      // Sorted in, so a restored row returns to its old place.
      const next = [...list, memory].sort((a, b) => a.created_at - b.created_at);
      return { spaceMemories: { ...s.spaceMemories, [args.space_id]: next } };
    });
    return memory;
  },

  updateMemory: async (id, spaceId, content) => {
    const trimmed = content.trim();
    const changed = await updateSpaceMemory({ id, space_id: spaceId, content: trimmed });
    memoryWrites++;
    invalidateSpaceContext(spaceId);
    const now = Date.now();
    set((s) => {
      const list = s.spaceMemories[spaceId];
      if (!list) return s;
      return {
        spaceMemories: {
          ...s.spaceMemories,
          [spaceId]: changed
            ? list.map((m) => (m.id === id ? { ...m, content: trimmed, updated_at: now } : m))
            : list.filter((m) => m.id !== id),
        },
      };
    });
    return changed;
  },

  // Unlike the other delete/remove actions this one does NOT toast on failure
  // and instead propagates — the slash-command layer (`removeMemory` via a
  // chat command) awaits it and reports failures through the command-result
  // panel. The SpaceView UI caller attaches its own toast on the rejection.
  removeMemory: async (id, spaceId) => {
    const changed = await removeSpaceMemory({ id, space_id: spaceId });
    memoryWrites++;
    invalidateSpaceContext(spaceId);
    set((s) => {
      const list = s.spaceMemories[spaceId];
      if (!list) return s;
      return {
        spaceMemories: { ...s.spaceMemories, [spaceId]: list.filter((m) => m.id !== id) },
      };
    });
    return changed;
  },
}));
