// Tiny development-only logger.
//
// Why this exists: Tauri 2 leaves DevTools available in production builds
// unless explicitly disabled in `tauri.conf.json` (we don't disable it). The
// ~20 `console.warn` / `console.error` calls scattered across stores and
// helpers were leaking internal error context to anyone who opens DevTools
// on a shipped install. This module wraps them so the calls compile out
// entirely in production: `import.meta.env.DEV` is a Vite build-time constant
// — the bundler dead-code-eliminates the body when it's `false`, leaving
// nothing in `dist/`.
//
// Usage:
//   import { logger } from "@/lib/logger";
//   logger.warn("clipboard write failed", err);
//   logger.error("chat hydrate failed", err);
//
// Don't reach for `console.log` directly anywhere in `src/`. If you need a
// quick `printf`-debug, use `logger.debug` and clean it up before commit —
// the linter doesn't enforce it yet but the audit grep does.

const DEV = import.meta.env.DEV;

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

// Each method is its own const so the bundler can prove the function bodies
// are unreachable in production and drop them. A single `if (DEV) {}` block
// around an object literal would have the same source effect but would
// occasionally keep the references live in the minified bundle depending on
// Rollup's whim — this form is consistently dead-code-eliminated.
const noop = () => {};

export const logger: Logger = {
  info: DEV ? console.info.bind(console) : noop,
  warn: DEV ? console.warn.bind(console) : noop,
  error: DEV ? console.error.bind(console) : noop,
  debug: DEV ? console.debug.bind(console) : noop,
};
