import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  DEFAULT_SETTINGS,
  type BackgroundStyle,
  type ProviderId,
  type Settings,
} from "@/types";
import {
  getOpenAIKeyStatus,
  getSettings,
  setOpenAIKey as setOpenAIKeyCmd,
  clearOpenAIKey as clearOpenAIKeyCmd,
  setSetting,
} from "@/lib/tauri";
import { pushRecentCommand } from "@/lib/commands/recency";
import { useToastStore } from "./toastStore";

interface SettingsState extends Settings {
  openai_key_set: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  setOpenAIKey: (key: string) => Promise<void>;
  clearOpenAIKey: () => Promise<void>;
  setProviderDefault: (provider: ProviderId, model: string) => Promise<void>;
  /** Note that a slash command just ran, so the palette can float it to the
   *  top next time. Fire-and-forget by design — see the implementation. */
  recordCommandUse: (name: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  openai_key_set: false,
  hydrated: false,

  hydrate: async () => {
    try {
      // Fire the settings read and the OpenAI-key keyring probe concurrently:
      // they're independent, and the probe (a spawn_blocking keyring read on
      // the Rust side) otherwise serialized a whole round-trip after the SQLite
      // read. getSettings rejecting still hits the outer catch; the key probe
      // keeps its own fallback so a keyring failure never blocks hydration.
      const [rows, hasKey] = await Promise.all([
        getSettings(),
        getOpenAIKeyStatus().catch(() => false),
      ]);
      const merged: Settings = { ...DEFAULT_SETTINGS };
      // Settings live in a string-keyed KV table; coerce each value back into
      // the type implied by DEFAULT_SETTINGS so booleans don't arrive as the
      // literal string "false" (which is truthy).
      (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).forEach((k) => {
        const v = rows[k];
        if (v === undefined) return;
        const def = DEFAULT_SETTINGS[k];
        if (typeof def === "boolean") {
          (merged as unknown as Record<string, unknown>)[k as string] = v === "true";
        } else {
          (merged as unknown as Record<string, unknown>)[k as string] = v;
        }
      });
      set({ ...merged, openai_key_set: hasKey, hydrated: true });
      applyTheme(merged.theme);
      applyFontSize(merged.font_size);
      applyBackground(merged.background_style);
    } catch (e) {
      logger.error("settings hydrate failed", e);
      set({ hydrated: true });
    }
  },

  update: async (key, value) => {
    // Optimistic update so toggles / dropdowns feel instant (the SQLite write
    // is sub-millisecond but the React render shouldn't wait on the IPC
    // round-trip). If the persistence fails, roll the local state back so
    // the UI matches what's actually on disk.
    const prev = (get() as unknown as Record<string, unknown>)[
      key as string
    ] as Settings[typeof key];
    set({ [key]: value } as Partial<SettingsState>);
    if (key === "theme") applyTheme(value as Settings["theme"]);
    if (key === "font_size") applyFontSize(value as Settings["font_size"]);
    if (key === "background_style") applyBackground(value as BackgroundStyle);

    try {
      await setSetting(String(key), String(value));
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save setting",
        body: e instanceof Error ? e.message : String(e),
      });
      // Revert both the state and any visual side-effect we applied above.
      set({ [key]: prev } as Partial<SettingsState>);
      if (key === "theme") applyTheme(prev as Settings["theme"]);
      if (key === "font_size") applyFontSize(prev as Settings["font_size"]);
      if (key === "background_style") applyBackground(prev as BackgroundStyle);
    }
  },

  setOpenAIKey: async (key: string) => {
    await setOpenAIKeyCmd(key);
    set({ openai_key_set: true });
  },

  clearOpenAIKey: async () => {
    await clearOpenAIKeyCmd();
    set({ openai_key_set: false });
  },

  setProviderDefault: async (provider, model) => {
    // Persist both rows BEFORE updating state. The two writes can't be wrapped
    // in a single SQLite transaction over the IPC bridge (we'd need a new
    // command for that), so we sequence them carefully:
    //   1. Write provider. On failure → toast and bail; nothing changed.
    //   2. Write model. On failure → revert provider so the DB stays
    //      internally consistent (a non-matching provider/model pair would
    //      confuse the model-resolver on next boot).
    try {
      await setSetting("default_provider", provider);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save default provider",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    try {
      await setSetting("default_model", model);
    } catch (e) {
      // Roll back the provider write so the DB doesn't end up with the new
      // provider paired against the old model.
      const prevProvider = get().default_provider;
      await setSetting("default_provider", prevProvider).catch(() => {});
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save default model",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    set({ default_provider: provider, default_model: model });
  },

  recordCommandUse: (name) => {
    const prev = get().recent_commands;
    const next = pushRecentCommand(prev, name);
    // Already the most-recent entry — nothing to write, and skipping the
    // `set` avoids re-rendering the composer on every repeat of a command.
    if (next === prev) return;
    set({ recent_commands: next });
    // Deliberately not routed through `update()`: that surfaces a toast on
    // failure, and "couldn't save your command history" is noise on top of
    // whatever the user was actually doing. The in-memory list above still
    // works for this session; the next successful write repairs the row.
    void setSetting("recent_commands", next).catch((e) => {
      logger.warn("recent-command persist failed", e);
    });
  },
}));

let systemThemeMediaQuery: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function applyTheme(theme: Settings["theme"]) {
  const root = document.documentElement;
  const mm = window.matchMedia?.("(prefers-color-scheme: dark)");

  // Unhook previous listener (if theme switched from 'system' to explicit).
  if (systemThemeMediaQuery && systemThemeListener) {
    systemThemeMediaQuery.removeEventListener("change", systemThemeListener);
    systemThemeMediaQuery = null;
    systemThemeListener = null;
  }

  const resolve = () => {
    const prefersDark =
      theme === "dark" || (theme === "system" && !!mm?.matches);
    root.classList.toggle("dark", prefersDark);
  };
  resolve();

  // Follow OS changes when in 'system' mode.
  if (theme === "system" && mm) {
    systemThemeMediaQuery = mm;
    systemThemeListener = () => resolve();
    mm.addEventListener("change", systemThemeListener);
  }
}

function applyFontSize(size: Settings["font_size"]) {
  const root = document.documentElement;
  root.classList.remove("font-size-small", "font-size-normal", "font-size-large");
  root.classList.add(`font-size-${size}`);
}

/** Mirror the background variant onto `<html>` so CSS can scope accent
 *  variables to it. `app-mesh` / `app-solid` already live on a child div for
 *  the actual backdrop; the html-level class is purely a hook for theming
 *  (e.g. flipping `--primary` between azure for Solid and orange for Aurora). */
function applyBackground(style: BackgroundStyle) {
  const root = document.documentElement;
  root.classList.toggle("bg-solid", style === "solid");
  root.classList.toggle("bg-gradient", style === "gradient");
}
