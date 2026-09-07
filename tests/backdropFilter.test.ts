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
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const stylesDir = fileURLToPath(new URL("../src/styles", import.meta.url));

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
