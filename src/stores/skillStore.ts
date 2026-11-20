import { create } from "zustand";
import { listSkills, sessionSkills, setSessionSkill, setSkillEnabled } from "@/lib/tauri";
import type { SkillCatalog } from "@/types";

/**
 * Agent Skills as the UI sees them: the installed catalogue (Settings →
 * Skills, `/skill`) and the skills switched on in each chat (the composer
 * chips). The backend reads skills from disk on every turn, so this is a
 * view, not a cache the prompt depends on — a stale list only shows stale
 * chips until the next load.
 */
interface SkillState {
  /** `null` until the first load. */
  catalog: SkillCatalog | null;
  /** Skill names switched on per chat, loaded on demand. */
  bySession: Record<string, string[]>;
  loadCatalog: () => Promise<SkillCatalog>;
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
  loadSession: (sessionId: string) => Promise<string[]>;
  /** Switch a skill on or off in a chat. Rejects (with the backend's
   *  message) when switching on a name that isn't an enabled skill. */
  setActive: (sessionId: string, name: string, active: boolean) => Promise<void>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  catalog: null,
  bySession: {},

  loadCatalog: async () => {
    const catalog = await listSkills();
    set({ catalog });
    return catalog;
  },

  setEnabled: async (name, enabled) => {
    await setSkillEnabled(name, enabled);
    // Re-read rather than patch the one row: the switch is kept under the
    // skill's folder name too, which can be another skill's.
    if (get().catalog) await get().loadCatalog();
  },

  loadSession: async (sessionId) => {
    const names = await sessionSkills(sessionId);
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: names } }));
    return names;
  },

  setActive: async (sessionId, name, active) => {
    await setSessionSkill(sessionId, name, active);
    await get().loadSession(sessionId);
  },
}));
