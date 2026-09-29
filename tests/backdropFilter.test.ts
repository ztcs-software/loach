// Build-pipeline invariant: never hand-write `-webkit-backdrop-filter` in the
// stylesheets. Vite 8 minifies CSS with Lightning CSS, and Lightning CSS
// (1.33, parcel-bundler/lightningcss#695, vitejs/vite#22649) DELETES the
// unprefixed `backdrop-filter` from any rule that also carries the -webkit-
// spelling. Chromium/WebView2 only honours the unprefixed property, so the
// shipped Windows build lost every glass blur while `npm run tauri dev`
// (unminified) looked fine — v1.4.0 and v1.4.1 went out that way.
//
// Writing only `backdrop-filter` is enough: Lightning CSS adds the -webkit-
// copy itself for the `safari13` target the Linux/macOS builds use.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const stylesDir = fileURLToPath(new URL("../src/styles", import.meta.url));
const builtAssets = fileURLToPath(new URL("../dist/assets", import.meta.url));

describe("backdrop-filter is written unprefixed only", () => {
  for (const file of readdirSync(stylesDir).filter((f) => f.endsWith(".css"))) {
    it(`src/styles/${file}`, () => {
      const offending = readFileSync(path.join(stylesDir, file), "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes("-webkit-backdrop-filter"))
        .map(({ n, line }) => `${n}: ${line.trim()}`);
      expect(offending).toEqual([]);
    });
  }
});

// The rule above guards the input; this guards what actually ships. CI runs
// `npm run build` before `npm test`, so there it reads the minified CSS the
// release bundles — a future minifier change that strips the unprefixed
// property again fails here even with clean sources. Skipped when there is
// no build to read (a plain local `npm test`).
const builtCss = existsSync(builtAssets)
  ? readdirSync(builtAssets).filter((f) => f.endsWith(".css"))
  : [];

describe("the built CSS keeps the unprefixed backdrop-filter", () => {
  it.skipIf(builtCss.length === 0)("in every rule that blurs", () => {
    const rules = builtCss.flatMap((f) =>
      readFileSync(path.join(builtAssets, f), "utf8").split("}"),
    );
    // Declarations, not mentions: `transition-property` lists the property
    // by name too.
    const unprefixed = /(^|[{;\s])backdrop-filter\s*:/;
    const prefixed = /-webkit-backdrop-filter\s*:/;
    expect(rules.some((r) => unprefixed.test(r))).toBe(true);
    // The bug's exact shape: the -webkit- copy survived, the real one didn't.
    const stripped = rules.filter((r) => prefixed.test(r) && !unprefixed.test(r));
    expect(stripped).toEqual([]);
  });
});
