import { create } from "zustand";
import { logger } from "@/lib/logger";
import { useToastStore } from "./toastStore";
import {
  addSpaceFile,
  addSpaceMemory,
  createSpace,
  deleteSpace,
  listSpaceFiles,
  listSpaceMemories,
  listSpaces,
  removeSpaceFile,
  removeSpaceMemory,
  updateSpace,
  updateSpaceMemory,
} from "@/lib/tauri";
import { SPACE_BYTES_CAP } from "@/lib/files";
import {
  invalidateSpaceContext,
  invalidateAllSpaceContext,
} from "@/lib/spaceContextCache";
import type { Space, SpaceFile, SpaceMemory } from "@/types";

interface SpaceState {
  spaces: Space[];
  activeSpaceId: string | null;
  viewingSpaceId: string | null;
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
  setViewingSpace: (id: string | null) => void;

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

  loadSpaceMemories: (spaceId: string) => Promise<SpaceMemory[]>;
  /** Insert a new memory and return the persisted row. Used by both the
   *  extractor (auto-save) and the Memory tab's "Add manually" affordance.
   *  Source ids are optional so manual entries leave both NULL. */
  addMemory: (args: {
    space_id: string;
    content: string;
    source_session_id?: string | null;
    source_message_id?: string | null;
  }) => Promise<SpaceMemory>;
  updateMemory: (id: string, spaceId: string, content: string) => Promise<void>;
  removeMemory: (id: string, spaceId: string) => Promise<void>;
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  activeSpaceId: null,
  viewingSpaceId: null,
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

  updateSpace: async (id, fields) => {
    // Snapshot the current row so callers can pass a partial set of fields
    // (e.g. just the name, just the model) without clobbering the rest.
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
      };
    });
    return true;
  },

  setSpaceFormOpen: (open) => set({ spaceFormOpen: open }),
  setViewingSpace: (id) => set({ viewingSpaceId: id, activeSpaceId: id }),

  loadSpaceFiles: async (spaceId) => {
    const files = await listSpaceFiles(spaceId);
    set((s) => ({ spaceFiles: { ...s.spaceFiles, [spaceId]: files } }));
    return files;
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
      invalidateSpaceContext(spaceId);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't remove file",
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

  loadSpaceMemories: async (spaceId) => {
    const memories = await listSpaceMemories(spaceId);
    set((s) => ({ spaceMemories: { ...s.spaceMemories, [spaceId]: memories } }));
    return memories;
  },

  addMemory: async (args) => {
    const memory = await addSpaceMemory(args);
    invalidateSpaceContext(args.space_id);
    set((s) => ({
      spaceMemories: {
        ...s.spaceMemories,
        [args.space_id]: [...(s.spaceMemories[args.space_id] ?? []), memory],
      },
    }));
    return memory;
  },

  updateMemory: async (id, spaceId, content) => {
    const trimmed = content.trim();
    await updateSpaceMemory({ id, space_id: spaceId, content: trimmed });
    invalidateSpaceContext(spaceId);
    const now = Date.now();
    set((s) => ({
      spaceMemories: {
        ...s.spaceMemories,
        [spaceId]: (s.spaceMemories[spaceId] ?? []).map((m) =>
          m.id === id ? { ...m, content: trimmed, updated_at: now } : m,
        ),
      },
    }));
  },

  // Unlike the other delete/remove actions this one does NOT toast on failure
  // and instead propagates — the slash-command layer (`removeMemory` via a
  // chat command) awaits it and reports failures through the command-result
  // panel. The SpaceView UI caller attaches its own toast on the rejection.
  removeMemory: async (id, spaceId) => {
    await removeSpaceMemory({ id, space_id: spaceId });
    invalidateSpaceContext(spaceId);
    set((s) => ({
      spaceMemories: {
        ...s.spaceMemories,
        [spaceId]: (s.spaceMemories[spaceId] ?? []).filter((m) => m.id !== id),
      },
    }));
  },
}));

;(window as unknown as {__spaceStore?: unknown}).__spaceStore = useSpaceStore;
