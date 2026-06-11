// Release-gate invariant: the version string lives in three files and the
// release workflow (.github/workflows/release.yml `prepare` job) HARD-FAILS
// when they disagree — but only after the PR has already merged to main.
// This test moves that failure to `npm test` time, before anything ships.
//
// Parsing mirrors the workflow: package.json / tauri.conf.json are read as
// JSON; Cargo.toml takes the first `version = "…"` line of the [package]
// section (dependency tables use inline `{ version = "…" }`, which never
// starts a line).

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

  it("finds a plausible version in all three files", () => {
    // A semver-ish shape guard so a broken parse fails with a clear message
    // instead of passing vacuously (undefined === undefined).
    for (const [name, v] of [
      ["package.json", pkg],
      ["src-tauri/tauri.conf.json", tauri],
      ["src-tauri/Cargo.toml", cargo],
    ] as const) {
      expect(v, `${name} version`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("package.json, tauri.conf.json, and Cargo.toml agree", () => {
    expect(
      { tauriConf: tauri, cargoToml: cargo },
      "the release workflow hard-fails on drift — fix the odd one out and run `cargo update -p loach`",
    ).toEqual({ tauriConf: pkg, cargoToml: pkg });
  });
});
