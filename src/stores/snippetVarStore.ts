import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  createSnippetVariable,
  deleteSnippetVariable,
  listSnippetFillValues,
  listSnippetVariables,
  updateSnippetVariable,
  upsertSnippetFillValues,
} from "@/lib/tauri";
import type { SnippetVariable } from "@/types";

/** Open the create/edit dialog: `"new"` for create mode, a row for edit. */
type VarDialogTarget = SnippetVariable | "new" | null;

/** Active fill-blanks request. The expansion helper sets this when a
 *  snippet still has unresolved `{{VAR}}` placeholders after the static
 *  pass; the `SnippetVariableFillDialog` reads it, gathers values, and
 *  calls `onSubmit` with the final composer-ready prompt. */
export interface PendingFill {
  snippetId: string;
  snippetTitle: string;
  /** Prompt with built-ins + globals already substituted. */
  partiallyResolved: string;
  /** Keys still needing user input, in first-appearance order. */
  unresolved: string[];
  /** Pre-filled values from previous runs (may be partial). */
  recall: Record<string, string>;
  onSubmit: (finalPrompt: string, values: Record<string, string>) => void;
  onCancel: () => void;
}

interface SnippetVarState {
  variables: SnippetVariable[];
  /** Per-snippet recall of the values the user typed into the fill-blanks
   *  dialog on the previous run. Hydrated lazily — entries appear here the
   *  first time someone opens the dialog for that snippet. */
  fillValuesBySnippet: Record<string, Record<string, string>>;
  dialogTarget: VarDialogTarget;
  pendingFill: PendingFill | null;

  setPendingFill: (fill: PendingFill | null) => void;

  hydrate: () => Promise<void>;
  create: (
    key: string,
    value: string,
    description: string | null,
  ) => Promise<SnippetVariable>;
  update: (
    id: string,
    key: string,
    value: string,
    description: string | null,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;

  /** Load the per-snippet recall map (cached after first call per snippet).
   *  Returns the cached map directly when already loaded — the dialog reads
   *  this synchronously to seed input values. */
  loadFillValues: (snippetId: string) => Promise<Record<string, string>>;
  /** Persist a batch of `(key, value)` pairs for `snippetId`. Updates the
   *  in-memory cache optimistically; failures fall back to a warning log
   *  rather than blocking the snippet from running. */
  saveFillValues: (
    snippetId: string,
    values: Record<string, string>,
  ) => Promise<void>;

  openDialog: (target: VarDialogTarget) => void;
  closeDialog: () => void;
}

export const useSnippetVarStore = create<SnippetVarState>((set, get) => ({
  variables: [],
  fillValuesBySnippet: {},
  dialogTarget: null,
  pendingFill: null,

  setPendingFill: (pendingFill) => set({ pendingFill }),

  hydrate: async () => {
    try {
      const variables = await listSnippetVariables();
      set({ variables });
    } catch (e) {
      logger.error("snippet variables hydrate failed", e);
    }
  },

  create: async (key, value, description) => {
    const v = await createSnippetVariable({
      key,
      value,
      description: description ?? null,
    });
    set((s) => ({ variables: [...s.variables, v].sort((a, b) => a.key.localeCompare(b.key)) }));
    return v;
  },

  update: async (id, key, value, description) => {
    await updateSnippetVariable({
      id,
      key,
      value,
      description: description ?? null,
    });
    // Don't fabricate `updated_at: Date.now()` — the command returns void,
    // so we don't know the server's real timestamp. Guessing it risks a
    // value that disagrees with the DB (and would mis-sort a future
    // "recently edited" view). Keep the prior `updated_at`; the list sorts
    // by key, so the displayed timestamp is never a guess.
    set((s) => ({
      variables: s.variables
        .map((v) => (v.id === id ? { ...v, key, value, description } : v))
        .sort((a, b) => a.key.localeCompare(b.key)),
    }));
  },

  remove: async (id) => {
    await deleteSnippetVariable(id);
    set((s) => ({ variables: s.variables.filter((v) => v.id !== id) }));
  },

  loadFillValues: async (snippetId) => {
    const cached = get().fillValuesBySnippet[snippetId];
    if (cached) return cached;
    try {
      const rows = await listSnippetFillValues(snippetId);
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key] = r.value;
      set((s) => ({
        fillValuesBySnippet: { ...s.fillValuesBySnippet, [snippetId]: map },
      }));
      return map;
    } catch (e) {
      logger.warn("snippet fill values load failed", e);
      return {};
    }
  },

  saveFillValues: async (snippetId, values) => {
    // Optimistic local update so the next dialog open sees the new values
    // even if the disk write is still in flight.
    set((s) => ({
      fillValuesBySnippet: {
        ...s.fillValuesBySnippet,
        [snippetId]: { ...(s.fillValuesBySnippet[snippetId] ?? {}), ...values },
      },
    }));
    try {
      const tuples = Object.entries(values) as [string, string][];
      await upsertSnippetFillValues({ snippet_id: snippetId, values: tuples });
    } catch (e) {
      // Recall is a convenience, not critical state — log and move on.
      logger.warn("snippet fill values save failed", e);
    }
  },

  openDialog: (target) => set({ dialogTarget: target }),
  closeDialog: () => set({ dialogTarget: null }),
}));
