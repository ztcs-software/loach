import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone from vite.config.ts (vitest does not auto-merge it). We only need
// the `@` path alias; the React plugin isn't required because the tests cover
// plain-TS store logic, not components. The default `node` environment is
// enough — the streaming-store tests don't touch the DOM, and the one browser
// API the store uses at runtime (requestAnimationFrame) is shimmed in-test.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    // `tests/` holds repo-level invariants (e.g. the release version
    // agreement check) that don't belong next to any src module.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
