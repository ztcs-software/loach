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
  }) => Promise<GlobalMemory>;
  updateMemory: (id: string, content: string) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
}

export const useGlobalMemoryStore = create<GlobalMemoryState>((set, get) => ({
  memories: null,

  load: async () => {
    const memories = await listGlobalMemories();
    set({ memories });
    return memories;
  },

  ensureLoaded: async () => get().memories ?? (await get().load()),

  addMemory: async (args) => {
    const memory = await addGlobalMemory(args);
    set((s) => ({ memories: [...(s.memories ?? []), memory] }));
    return memory;
  },

  updateMemory: async (id, content) => {
    const trimmed = content.trim();
    await updateGlobalMemory({ id, content: trimmed });
    const now = Date.now();
    set((s) => ({
      memories: (s.memories ?? []).map((m) =>
        m.id === id ? { ...m, content: trimmed, updated_at: now } : m,
      ),
    }));
  },

  removeMemory: async (id) => {
    await removeGlobalMemory({ id });
    set((s) => ({ memories: (s.memories ?? []).filter((m) => m.id !== id) }));
  },
}));
