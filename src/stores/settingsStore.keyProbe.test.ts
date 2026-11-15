// The OpenAI-key keyring probe is its own step (`hydrateOpenAIKey`). Inside
// `hydrate` it held the settings back — and with them the theme, onboarding
// and the model preload — for as long as the OS keyring took, which can be a
// macOS Keychain prompt after an update.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve({ ollama_base_url: "http://gpu-box:11434" })),
  getOpenAIKeyStatus: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, getSettings: mocks.getSettings, getOpenAIKeyStatus: mocks.getOpenAIKeyStatus };
});

// `hydrate` applies the theme to <html>; the node environment has no DOM.
vi.stubGlobal("document", { documentElement: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } } });
vi.stubGlobal("window", {});

import { useSettingsStore } from "./settingsStore";

describe("settings hydrate and the keyring probe", () => {
  beforeEach(() => {
    mocks.getOpenAIKeyStatus.mockReset();
    useSettingsStore.setState({ hydrated: false, openai_key_set: false });
  });

  it("loads the settings without asking the keyring", async () => {
    mocks.getOpenAIKeyStatus.mockReturnValue(new Promise(() => {})); // a prompt nobody answers
    await useSettingsStore.getState().hydrate();
    const s = useSettingsStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.ollama_base_url).toBe("http://gpu-box:11434");
    expect(mocks.getOpenAIKeyStatus).not.toHaveBeenCalled();
  });

  it("sets the key flag from the keyring, and an unreadable keyring as no key", async () => {
    mocks.getOpenAIKeyStatus.mockResolvedValue(true);
    await useSettingsStore.getState().hydrateOpenAIKey();
    expect(useSettingsStore.getState().openai_key_set).toBe(true);

    mocks.getOpenAIKeyStatus.mockRejectedValue(new Error("Secret Service unavailable"));
    await useSettingsStore.getState().hydrateOpenAIKey();
    expect(useSettingsStore.getState().openai_key_set).toBe(false);
  });
});
