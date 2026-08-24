/// <reference types="vite/client" />

declare module "mammoth/mammoth.browser" {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
}

/** Injected by vite `define` from package.json — see vite.config.ts. */
declare const __APP_VERSION__: string;
