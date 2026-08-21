// Release-gate invariant: the version string lives in three files and the
// release workflow (.github/workflows/release.yml `prepare` job) HARD-FAILS
// when they disagree — but only after the PR has already merged to main.
// This test moves that failure to `npm test` time, before anything ships.
//
// Cargo.lock is checked too. The workflow doesn't compare it, so a forgotten
// `cargo update -p loach` slips past the version gate and instead fails much
// later at CI's `cargo test --locked` (and at the release build, which builds
// from the lockfile) with an error that doesn't obviously say "you bumped the
// version and didn't refresh the lockfile".
//
// Parsing mirrors the workflow: package.json / tauri.conf.json are read as
// JSON; Cargo.toml takes the first `version = "…"` line of the [package]
// section (dependency tables use inline `{ version = "…" }`, which never
// starts a line). Cargo.lock is matched on the `[[package]]` entry whose
// name is `loach` — every dependency has the same shape, so anchoring on the
// name is what keeps this from reading some crate's version instead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");

describe("release version agreement", () => {
  const pkg = (JSON.parse(read("package.json")) as { version?: unknown }).version;
  const tauri = (
    JSON.parse(read("src-tauri", "tauri.conf.json")) as { version?: unknown }
  ).version;
  const cargoToml = read("src-tauri", "Cargo.toml");
  const cargo = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
  const cargoLockText = read("src-tauri", "Cargo.lock");
  // Line-walk rather than a multi-line regex: every dependency in the lock
  // file has the identical `name = ` / `version = ` shape, so the anchor that
  // matters is the name, and `version` is always the line right after it.
  const cargoLock = (() => {
    const lines = cargoLockText.split("\n").map((l) => l.trimEnd());
    const i = lines.indexOf('name = "loach"');
    if (i === -1) return undefined;
    return /^version = "([^"]+)"$/.exec(lines[i + 1] ?? "")?.[1];
  })();

  it("finds a plausible version in all three files", () => {
    // A semver-ish shape guard so a broken parse fails with a clear message
    // instead of passing vacuously (undefined === undefined).
    for (const [name, v] of [
      ["package.json", pkg],
      ["src-tauri/tauri.conf.json", tauri],
      ["src-tauri/Cargo.toml", cargo],
      ["src-tauri/Cargo.lock", cargoLock],
    ] as const) {
      expect(v, `${name} version`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("package.json, tauri.conf.json, Cargo.toml, and Cargo.lock agree", () => {
    expect(
      { tauriConf: tauri, cargoToml: cargo, cargoLock },
      "the release workflow hard-fails on drift — fix the odd one out, then run `cargo update -p loach` to refresh the lockfile",
    ).toEqual({ tauriConf: pkg, cargoToml: pkg, cargoLock: pkg });
  });
});
