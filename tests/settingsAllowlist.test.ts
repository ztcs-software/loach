// Settings-write invariant: the renderer persists every key of
// `DEFAULT_SETTINGS` (src/types.ts) through the `set_setting` IPC command,
// which rejects keys missing from `WRITABLE_SETTING_KEYS` in
// src-tauri/src/commands.rs (built-in tool toggles come from the tool
// registry instead and all end in `_tool_enabled`). The two files are
// maintained by hand in different languages, so neither `tsc` nor `cargo
// check` can see them drift — a key added on the TS side but not the Rust
// side only fails at runtime, as a "not on the writable allowlist" toast
// when the user touches that setting. This test moves the failure to
// `npm test` time. (Regression: `ollama_keep_alive` shipped in the UI
// without an allowlist entry, making the new control un-saveable.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../src/types";

const root = fileURLToPath(new URL("..", import.meta.url));
const commandsRs = readFileSync(
  path.join(root, "src-tauri", "src", "commands.rs"),
  "utf8",
);

const block = /const WRITABLE_SETTING_KEYS:[^=]*=\s*&\[([\s\S]*?)\];/.exec(
  commandsRs,
)?.[1];
const allowlist = [...(block ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

describe("settings allowlist agreement (types.ts vs commands.rs)", () => {
  it("finds the WRITABLE_SETTING_KEYS const in commands.rs", () => {
    // Parse guard so a refactor of commands.rs fails loudly here instead of
    // letting the assertions below pass vacuously against an empty list.
    expect(allowlist).toContain("theme");
  });

  it("every DEFAULT_SETTINGS key is writable via set_setting", () => {
    const unwritable = Object.keys(DEFAULT_SETTINGS).filter(
      (k) => !k.endsWith("_tool_enabled") && !allowlist.includes(k),
    );
    expect(
      unwritable,
      "add these to WRITABLE_SETTING_KEYS in src-tauri/src/commands.rs — " +
        "the Settings UI cannot save them otherwise",
    ).toEqual([]);
  });

  it("the allowlist holds no stale keys absent from DEFAULT_SETTINGS", () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    const stale = allowlist.filter((k) => !keys.includes(k));
    expect(
      stale,
      "remove these from WRITABLE_SETTING_KEYS (or add them to DEFAULT_SETTINGS) — " +
        "the comment on the const promises the two stay in lockstep",
    ).toEqual([]);
  });
});
