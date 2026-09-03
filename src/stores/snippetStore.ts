import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
} from "@/lib/tauri";
import { useToastStore } from "./toastStore";
import type { ProviderId, Snippet } from "@/types";

/** Open a fresh snippet dialog with the prompt textarea pre-filled. */
export interface NewSnippetSeed {
  seedPrompt: string;
}

interface SnippetState {
  snippets: Snippet[];
  /** When non-null, the dialog opens in edit mode; when `"new"`, it opens in
   *  create mode; when a `NewSnippetSeed`, opens in create mode with the
   *  prompt pre-filled. `null` keeps the dialog closed. */
  dialogTarget: Snippet | "new" | NewSnippetSeed | null;
  /** True once `hydrate()` has run (success or failure) so the library can tell
   *  "still loading" apart from "genuinely empty". */
  hydrated: boolean;
  /** Non-null when the last hydrate failed — drives the library's retry UI. */
  error: string | null;

  hydrate: () => Promise<void>;
  create: (
    title: string,
    prompt: string,
    provider: ProviderId | null,
    model: string | null,
  ) => Promise<Snippet>;
  update: (
    id: string,
    title: string,
    prompt: string,
    provider: ProviderId | null,
    model: string | null,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  openDialog: (target: Snippet | "new" | NewSnippetSeed) => void;
  closeDialog: () => void;
}

export const useSnippetStore = create<SnippetState>((set) => ({
  snippets: [],
  dialogTarget: null,
  hydrated: false,
  error: null,

  hydrate: async () => {
    try {
      const snippets = await listSnippets();
      set({ snippets, hydrated: true, error: null });
    } catch (e) {
      logger.error("snippet hydrate failed", e);
      set({
        hydrated: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  create: async (title, prompt, provider, model) => {
    const snippet = await createSnippet({
      title,
      prompt,
      attachments_json: null,
      provider: provider ?? null,
      model: model ?? null,
    });
    set((s) => ({ snippets: [snippet, ...s.snippets] }));
    return snippet;
  },

  update: async (id, title, prompt, provider, model) => {
    await updateSnippet({
      id,
      title,
      prompt,
      attachments_json: null,
      provider: provider ?? null,
      model: model ?? null,
    });
    set((s) => ({
      snippets: s.snippets.map((sn) =>
        sn.id === id
          ? { ...sn, title, prompt, provider, model, updated_at: Date.now() }
          : sn,
      ),
    }));
  },

  remove: async (id) => {
    try {
      await deleteSnippet(id);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't delete snippet",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) }));
  },

  openDialog: (target) => set({ dialogTarget: target }),
  closeDialog: () => set({ dialogTarget: null }),
}));
