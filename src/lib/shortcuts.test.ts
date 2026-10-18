// The primary modifier is Cmd alone on macOS, so Ctrl+K / Ctrl+N / Ctrl+F
// reach the text field as Cocoa's editing bindings instead of firing Loach
// shortcuts. `IS_MAC` is read once at import, so each case loads the module
// afresh under a stubbed `navigator`.

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadOn(platform: string) {
  vi.stubGlobal("navigator", { platform });
  vi.resetModules();
  return import("./shortcuts");
}

const press = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("primary modifier", () => {
  it("is Cmd only on macOS", async () => {
    const { SHORTCUTS, matches } = await loadOn("MacIntel");
    const newChat = SHORTCUTS.find((s) => s.action === "new-chat")!;
    expect(matches(newChat, press("n", { metaKey: true }))).toBe(true);
    expect(matches(newChat, press("n", { ctrlKey: true }))).toBe(false);
  });

  it("is Ctrl on Windows and Linux", async () => {
    for (const platform of ["Win32", "Linux x86_64"]) {
      const { SHORTCUTS, matches } = await loadOn(platform);
      const newChat = SHORTCUTS.find((s) => s.action === "new-chat")!;
      expect(matches(newChat, press("n", { ctrlKey: true })), platform).toBe(true);
      expect(matches(newChat, press("n")), platform).toBe(false);
    }
  });
});
