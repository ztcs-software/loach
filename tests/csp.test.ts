// The window CSP's `frame-src` is the one thing that stops the HTML preview
// (src-tauri/src/sandbox.rs) from navigating its frame to an outside URL —
// wry's navigation hook only watches the main frame — and the preview frame
// is the only frame the app has. Widening it (`https:`, `*`, `'self'`) would
// quietly let preview content load, or leak to, anything. Pin it here, along
// with the `script-src` the app itself relies on.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const conf = JSON.parse(
  readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
) as { app: { security: { csp: string } } };

const directives = new Map(
  conf.app.security.csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((parts) => parts[0])
    .map(([name, ...sources]) => [name, sources] as const),
);

describe("window CSP", () => {
  it("frames only the loach-sandbox protocol", () => {
    expect(directives.get("frame-src")).toEqual([
      "loach-sandbox:",
      "http://loach-sandbox.localhost",
    ]);
    // child-src would be consulted before default-src for frames too.
    expect(directives.has("child-src")).toBe(false);
  });

  it("keeps the app's own scripts to 'self'", () => {
    expect(directives.get("script-src")).toEqual(["'self'"]);
  });
});
