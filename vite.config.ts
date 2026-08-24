import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { createRequire } from "node:module";

// Read here, in Node, so the version reaches the bundle as a bare string
// literal. Importing `package.json` from a component instead pulled the whole
// manifest — dependency list, scripts and all — into the production chunk,
// because the JSON module isn't tree-shaken per key.
const { version: appVersion } = createRequire(import.meta.url)(
  "./package.json",
) as { version: string };

// Tauri expects a fixed port, fail if that port is not available
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // List the specific Tauri env vars we want exposed instead of using the
  // wildcard `TAURI_ENV_*`. A wildcard would scoop up any future variable
  // a developer accidentally sets locally (e.g. `TAURI_ENV_SECRET=…`) into
  // the bundle. Tauri only sets the four below in its dev/build env, so an
  // explicit list is both safer and more obviously a known surface.
  envPrefix: [
    "VITE_",
    "TAURI_ENV_PLATFORM",
    "TAURI_ENV_ARCH",
    "TAURI_ENV_FAMILY",
    "TAURI_ENV_DEBUG",
  ],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
