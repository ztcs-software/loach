import { create } from "zustand";
import {
  addGlobalMemory,
  listGlobalMemories,
  removeGlobalMemory,
  updateGlobalMemory,
} from "@/lib/tauri";
import type { GlobalMemory } from "@/types";

/**
 * Global (Space-independent) memory rows. Unlike the per-space cache in
 * `spaceStore`, this list IS the cache the prompt builder reads from: every
 * mutation goes through here and updates the list in place, so there is no
 * separate invalidation step. `null` until the first load so callers can
 * tell "not loaded yet" from "genuinely empty".
 */
interface GlobalMemoryState {
  memories: GlobalMemory[] | null;
  load: () => Promise<GlobalMemory[]>;
  /** Return the cached list, loading it once on first use. */
  ensureLoaded: () => Promise<GlobalMemory[]>;
  addMemory: (args: {
    content: string;
    source_session_id?: string | null;
    source_message_id?: string | null;
    restore_id?: string;
    restore_created_at?: number;
  }) => Promise<GlobalMemory>;
  /** `false` when the memory was already gone. */
  updateMemory: (id: string, content: string) => Promise<boolean>;
  /** `false` when the memory was already gone. */
  removeMemory: (id: string) => Promise<boolean>;
}

/** Writes completed so far. A load compares it before and after reading:
 *  a write that finished in between may be missing from what it read, while
 *  the write itself skipped the not-yet-loaded cache — so it reads again. */
let writes = 0;
/** The load in flight, shared by every `ensureLoaded` that arrives meanwhile. */
let loading: Promise<GlobalMemory[]> | null = null;

const byCreation = (a: GlobalMemory, b: GlobalMemory) => a.created_at - b.created_at;

export const useGlobalMemoryStore = create<GlobalMemoryState>((set, get) => ({
  memories: null,

  load: async () => {
    for (;;) {
      const before = writes;
      const memories = await listGlobalMemories();
      if (writes === before) {
        set({ memories });
        return memories;
      }
    }
  },

  ensureLoaded: () => {
    const cached = get().memories;
    if (cached) return Promise.resolve(cached);
    loading ??= get()
      .load()
      .finally(() => {
        loading = null;
      });
    return loading;
  },

  // The three writes below patch the cache only once it has been loaded.
  // Seeding an unloaded cache with a single row (`/remember` before anything
  // else read the list) would make `ensureLoaded` treat that row as the
  // whole list and hide every other global fact for the rest of the session.
  addMemory: async (args) => {
    const memory = await addGlobalMemory(args);
    writes++;
    // Sorted in, so a restored row returns to its old place.
    set((s) => (s.memories ? { memories: [...s.memories, memory].sort(byCreation) } : s));
    return memory;
  },

  updateMemory: async (id, content) => {
    const trimmed = content.trim();
    const changed = await updateGlobalMemory({ id, content: trimmed });
    writes++;
    const now = Date.now();
    set((s) =>
      s.memories
        ? {
            memories: changed
              ? s.memories.map((m) =>
                  m.id === id ? { ...m, content: trimmed, updated_at: now } : m,
                )
              : s.memories.filter((m) => m.id !== id),
          }
        : s,
    );
    return changed;
  },

  removeMemory: async (id) => {
    const changed = await removeGlobalMemory({ id });
    writes++;
    set((s) =>
      s.memories ? { memories: s.memories.filter((m) => m.id !== id) } : s,
    );
    return changed;
  },
}));
