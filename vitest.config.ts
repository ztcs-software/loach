import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone from vite.config.ts (vitest does not auto-merge it). We only need
// the `@` path alias; the React plugin isn't required because no test RENDERS
// a component — Markdown.test.ts imports a .tsx module but exercises only its
// plain-TS helpers (esbuild transpiles the JSX without the plugin). The
// default `node` environment is enough — the streaming-store tests don't
// touch the DOM, and the one browser API the store uses at runtime
// (requestAnimationFrame) is shimmed in-test. A future test that renders
// components needs the plugin plus a DOM environment, not just the globs.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    // `tests/` holds repo-level invariants (e.g. the release version
    // agreement check) that don't belong next to any src module. `.tsx`
    // included so a future component test isn't silently skipped.
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  },
});
