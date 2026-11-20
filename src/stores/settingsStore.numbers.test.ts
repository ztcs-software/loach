// The backend's startup preload reads `default_num_ctx` with
// `parse::<u32>`. Read any other way here, a hand-edited "32768.0" warmed the
// model at the default there and loaded it again at 32K for the first send.

import { describe, it, expect, vi } from "vitest";

const rows = vi.hoisted((): Record<string, string> => ({}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, getSettings: vi.fn(() => Promise.resolve(rows)) };
});

import { useSettingsStore } from "./settingsStore";
import { defaultNumCtx } from "@/lib/modelParams";

describe("numeric settings", () => {
  it.each([
    ["32768", 32768],
    ["+32768", 32768],
    ["32768.0", 16384],
    [" 32768", 16384],
    ["0x8000", 16384],
    ["1e4", 16384],
  ])("reads default_num_ctx %j as the backend does", async (raw, expected) => {
    rows.default_num_ctx = raw;
    await useSettingsStore.getState().hydrate();
    expect(defaultNumCtx(useSettingsStore.getState().default_num_ctx)).toBe(expected);
  });
});
