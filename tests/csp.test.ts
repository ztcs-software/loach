// The window CSP's `frame-src` is the one thing that stops the HTML preview
// (src-tauri/src/sandbox.rs) from navigating its frame to an outside URL —
// wry's navigation hook only watches the main frame — and the preview frame
// is the only frame the app has. Widening it (`https:`, `*`, `'self'`) would
// quietly let preview content load, or leak to, anything. Pin it here, along
// with the rest of the policy the app relies on.

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

  // All HTTP goes through Rust (CLAUDE.md, "Network and CSP"): the renderer
  // reaches nothing but the IPC bridge, and loads nothing from elsewhere.
  it("connects only to the IPC bridge", () => {
    expect(directives.get("connect-src")).toEqual(["ipc:", "http://ipc.localhost"]);
  });

  it("defaults to 'self' and keeps images local", () => {
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
  });
});

// An inline <style> in index.html makes Tauri add a style nonce to the CSP at
// build time, and with a nonce present CSP3 ignores `'unsafe-inline'` — so the
// <style> tags Radix and react-remove-scroll-bar inject are blocked, in release
// builds only.
describe("index.html", () => {
  it("has no inline <style> to earn a style nonce", () => {
    const html = readFileSync(path.join(root, "index.html"), "utf8")
      // Comments may talk about <style>; only real elements count.
      .replace(/<!--[\s\S]*?-->/g, "");
    expect(html).not.toMatch(/<style[\s>]/i);
  });
});

// The renderer holds only the permission sets it uses (see the comment in
// the file). `core:default` would bring back image, menu and tray, and
// `core:image:default` alone reads any PNG on disk via Image.fromPath.
describe("main window capabilities", () => {
  const caps = JSON.parse(
    readFileSync(path.join(root, "src-tauri", "capabilities", "default.json"), "utf8"),
  ) as { permissions: (string | { identifier: string })[] };
  const ids = caps.permissions.map((p) => (typeof p === "string" ? p : p.identifier));

  it("grants no core:default, image, menu or tray set", () => {
    expect(ids).toContain("core:window:default"); // parse guard
    const banned = ids.filter(
      (id) => id === "core:default" || /^core:(image|menu|tray):/.test(id),
    );
    expect(banned).toEqual([]);
  });
});
