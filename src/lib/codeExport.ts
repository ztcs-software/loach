import { isTauri, saveTextToFile } from "./tauri";

/**
 * Mapping from highlight.js / Prism language ids to the conventional file
 * extension we save with. Keys are lower-cased; aliases (`js` ↔ `javascript`)
 * are listed explicitly so we don't have to canonicalise inputs first.
 *
 * The list is intentionally finite. Anything we don't recognise falls back
 * to `.txt` — the user can still download the snippet, just without the
 * provider promising a particular file type.
 */
const EXT_MAP: Record<string, string> = {
  // web
  javascript: "js",
  js: "js",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  vue: "vue",
  svelte: "svelte",

  // data / config
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  ini: "ini",
  csv: "csv",

  // systems
  rust: "rs",
  rs: "rs",
  go: "go",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  csharp: "cs",
  cs: "cs",
  java: "java",
  kotlin: "kt",
  kt: "kt",
  swift: "swift",
  objectivec: "m",
  zig: "zig",

  // scripting
  python: "py",
  py: "py",
  ruby: "rb",
  rb: "rb",
  php: "php",
  perl: "pl",
  lua: "lua",

  // shells
  shell: "sh",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  powershell: "ps1",
  ps1: "ps1",
  ps: "ps1",
  bat: "bat",
  cmd: "bat",

  // db
  sql: "sql",

  // docs
  markdown: "md",
  md: "md",
  text: "txt",
  txt: "txt",
};

/** Files that conventionally have no extension — Dockerfile, Makefile.
 *  We save them as `Dockerfile` / `Makefile` instead of `snippet.dockerfile`. */
const BARE_FILENAMES: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
};

function extensionForLanguage(lang: string | undefined | null): string {
  if (!lang) return "txt";
  return EXT_MAP[lang.toLowerCase()] ?? "txt";
}

/** Default save name: `snippet.py`, `snippet.ts`, etc. — or the bare
 *  filename for Dockerfile / Makefile. */
export function defaultFilename(lang: string | undefined | null): string {
  const key = (lang ?? "").toLowerCase();
  if (BARE_FILENAMES[key]) return BARE_FILENAMES[key];
  return `snippet.${extensionForLanguage(lang)}`;
}

/**
 * Save a code snippet to disk. Inside Tauri this opens the native save
 * dialog (so the user can pick a location and even rename); in the browser
 * fallback (mock / preview) we trigger a Blob download instead.
 *
 * Returns the chosen path on Tauri (or `null` if the user cancelled), and
 * `undefined` in the browser fallback.
 */
export async function saveCodeToFile(
  raw: string,
  lang: string | undefined | null,
  hint?: string,
): Promise<string | null | undefined> {
  const defaultPath = hint?.trim() ? hint.trim() : defaultFilename(lang);
  const ext = extensionForLanguage(lang);

  if (isTauri) {
    // Dialog + write both happen in Rust through a single backend command,
    // so a compromised renderer can't bypass the picker and write to an
    // arbitrary path. The `txt` case uses an empty filter list so the user
    // gets the "All files" option.
    const filters =
      ext === "txt" ? undefined : [{ name: lang ?? ext, extensions: [ext] }];
    return await saveTextToFile({
      content: raw,
      default_path: defaultPath,
      filters,
    });
  }

  // Browser fallback — Blob download via a transient anchor.
  const blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultPath;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
