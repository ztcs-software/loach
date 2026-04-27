import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
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

interface SettingsState extends Settings {
  openai_key_set: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  setOpenAIKey: (key: string) => Promise<void>;
  clearOpenAIKey: () => Promise<void>;
  setProviderDefault: (provider: ProviderId, model: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  openai_key_set: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const rows = await getSettings();
      const merged: Settings = { ...DEFAULT_SETTINGS };
      // Settings live in a string-keyed KV table; coerce each value back into
      // the type implied by DEFAULT_SETTINGS so booleans don't arrive as the
      // literal string "false" (which is truthy).
      (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).forEach((k) => {
        const v = rows[k];
        if (v === undefined) return;
        const def = DEFAULT_SETTINGS[k];
        if (typeof def === "boolean") {
          (merged as Record<string, unknown>)[k as string] = v === "true";
        } else {
          (merged as Record<string, unknown>)[k as string] = v;
        }
      });
      const hasKey = await getOpenAIKeyStatus().catch(() => false);
      set({ ...merged, openai_key_set: hasKey, hydrated: true });
      applyTheme(merged.theme);
      applyBackgroundStyle(merged.background_style);
    } catch (e) {
      console.error("settings hydrate failed", e);
      set({ hydrated: true });
    }
  },

  update: async (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    await setSetting(String(key), String(value));
    if (key === "theme") applyTheme(value as Settings["theme"]);
    if (key === "background_style")
      applyBackgroundStyle(value as Settings["background_style"]);
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
    set({ default_provider: provider, default_model: model });
    await setSetting("default_provider", provider);
    await setSetting("default_model", model);
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

/** Toggles the `theme-solid` class on <html> so CSS overrides in
 *  globals.css can swap the accent palette to azure when the user picks
 *  the Solid background. Mirrors `applyTheme`'s shape so the wiring in
 *  hydrate / update reads consistently. */
function applyBackgroundStyle(style: Settings["background_style"]) {
  document.documentElement.classList.toggle("theme-solid", style === "solid");
}
