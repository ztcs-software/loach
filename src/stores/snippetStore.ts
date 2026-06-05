import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
} from "@/lib/tauri";
import { useToastStore } from "./toastStore";
import type { Attachment, ProviderId, Snippet } from "@/types";

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

  hydrate: async () => {
    try {
      const snippets = await listSnippets();
      set({ snippets });
    } catch (e) {
      logger.error("snippet hydrate failed", e);
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

/** Safe Attachment[] parser for the JSON we stored. Falls back to `[]`.
 *  Retained for forward-compat — the attachments UI is temporarily removed
 *  from snippets but the column and parser stay so existing rows aren't
 *  dropped on load. */
export function parseSnippetAttachments(json: string | null): Attachment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed as Attachment[];
  } catch {
    return [];
  }
}
