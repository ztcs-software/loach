// Settings-write invariant: the renderer persists every key of
// `DEFAULT_SETTINGS` (src/types.ts) through the `set_setting` IPC command,
// which rejects keys missing from `WRITABLE_SETTING_KEYS` in
// src-tauri/src/commands.rs (built-in tool toggles come from the tool
// registry in src-tauri/src/tools/builtin.rs instead and all end in
// `_tool_enabled`). The files are
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

// The tool toggles' half of the allowlist: every `setting_key` in the
// `BUILTINS` registry (src-tauri/src/tools/builtin.rs), either a literal or a
// `super::<module>::SETTING_KEY` const resolved from that module's file.
const toolsDir = path.join(root, "src-tauri", "src", "tools");
const registry =
  /const BUILTINS: &\[Builtin\] = &\[([\s\S]*?)\n\];/.exec(
    readFileSync(path.join(toolsDir, "builtin.rs"), "utf8"),
  )?.[1] ?? "";
const toolKeys = [
  ...new Set(
    [...registry.matchAll(/setting_key:\s*(?:"([^"]+)"|super::(\w+)::SETTING_KEY)/g)].map(
      ([, literal, module]) =>
        literal ??
        /pub const SETTING_KEY: &str = "([^"]+)";/.exec(
          readFileSync(path.join(toolsDir, `${module}.rs`), "utf8"),
        )?.[1],
    ),
  ),
];

describe("settings allowlist agreement (types.ts vs commands.rs)", () => {
  it("finds the WRITABLE_SETTING_KEYS const in commands.rs", () => {
    // Parse guard so a refactor of commands.rs fails loudly here instead of
    // letting the assertions below pass vacuously against an empty list.
    expect(allowlist).toContain("theme");
  });

  it("finds the tool toggles in the BUILTINS registry", () => {
    expect(toolKeys).toContain("calculate_tool_enabled");
    expect(toolKeys).toContain("workspace_tool_enabled");
    expect(toolKeys).not.toContain(undefined);
  });

  it("every DEFAULT_SETTINGS key is writable via set_setting", () => {
    const unwritable = Object.keys(DEFAULT_SETTINGS).filter(
      (k) => k.endsWith("_tool_enabled") ? !toolKeys.includes(k) : !allowlist.includes(k),
    );
    expect(
      unwritable,
      "add these to WRITABLE_SETTING_KEYS in src-tauri/src/commands.rs (or, for " +
        "a `*_tool_enabled` toggle, to BUILTINS in src-tauri/src/tools/builtin.rs) — " +
        "the Settings UI cannot save them otherwise",
    ).toEqual([]);
  });

  it("every registry tool toggle has a DEFAULT_SETTINGS entry", () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    expect(
      toolKeys.filter((k) => !keys.includes(k as string)),
      "add these to DEFAULT_SETTINGS in src/types.ts — the Settings UI has no " +
        "toggle for a tool without one",
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
