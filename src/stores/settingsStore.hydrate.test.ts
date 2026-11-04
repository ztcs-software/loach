// A settings read that failed looked exactly like a fresh install — the
// defaults, `onboarding_completed: false` among them — so an existing user
// got onboarding, which wrote its prompt and base URLs over theirs. The
// failure is recorded so the onboarding gate can tell the two apart.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getSettings: vi.fn(() => Promise.reject(new Error("database disk image is malformed"))),
  };
});

import { useSettingsStore } from "./settingsStore";

describe("settings hydrate", () => {
  it("records a failed read instead of passing it off as a fresh install", async () => {
    await useSettingsStore.getState().hydrate();
    const s = useSettingsStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.loadError).toBe("database disk image is malformed");
  });
});
