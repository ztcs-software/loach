/**
 * Snippet variable substitution.
 *
 * Snippets support two kinds of `{{KEY}}` placeholders:
 *
 *   - **Built-ins** — `{{USER_NAME}}` (from Settings) and the temporal vars
 *     `{{CURRENT_DATE}}` / `{{CURRENT_TIME}}` / `{{CURRENT_WEEKDAY}}` /
 *     `{{CURRENT_DATETIME}}` / `{{CURRENT_TIMEZONE}}` (from the local clock).
 *     These already exist in the chat path; we re-resolve them here so they
 *     also work inside a snippet body when it's primed into the composer.
 *
 *   - **Custom globals** — user-defined `SnippetVariable` rows. Keys are
 *     uppercase identifiers; values are arbitrary strings. Defined and
 *     managed from the Snippets Library page.
 *
 * Anything left over after both passes is treated as a **prompt-on-use**
 * placeholder — the caller opens a fill-blanks dialog, gathers values, and
 * runs `applyFillValues` to produce the final composer draft. The
 * detection regex is intentionally narrow (uppercase identifier inside
 * `{{ }}`, whitespace tolerated) so legitimate prose containing `{{foo}}`
 * or `{ x }` doesn't get flagged.
 */

import type { SnippetVariable } from "@/types";
import { temporalVars } from "@/lib/temporal";

/** Identifier shape that counts as a placeholder. Mirrors the Rust
 *  `normalise_var_key` validator: starts with a letter or underscore, then
 *  letters / digits / underscore, all uppercase. Whitespace inside the
 *  braces is tolerated so copy-paste from other tools doesn't break. */
const PLACEHOLDER_RE = /\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g;

/** Built-in keys that custom variables can't redefine — must stay in sync
 *  with `RESERVED_VAR_KEYS` in `src-tauri/src/commands.rs`. The server is
 *  the source of truth; this list exists for inline UI validation only. */
export const RESERVED_VAR_KEYS: readonly string[] = [
  "USER_NAME",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_WEEKDAY",
  "CURRENT_DATETIME",
  "CURRENT_TIMEZONE",
];

export interface SubstitutionResult {
  /** The prompt with every resolvable placeholder substituted. */
  resolved: string;
  /** Keys that appeared as `{{KEY}}` but had no value — caller asks the
   *  user to fill these in. De-duplicated, preserving first-appearance
   *  order so the fill dialog's input list matches the prompt reading
   *  order. */
  unresolved: string[];
}

/**
 * First pass: substitute every built-in + custom global the caller knows
 * about. Any `{{KEY}}` we can't resolve is returned in `unresolved` so the
 * caller can prompt the user. The function is pure — no DOM, no IO — and
 * deterministic for a given (prompt, globals, userName, now) tuple.
 *
 * @param prompt   The raw snippet body.
 * @param globals  User-defined custom variables.
 * @param userName Value to substitute for `{{USER_NAME}}` (from Settings).
 * @param now      Override clock for tests; defaults to wall time.
 */
export function expandKnownVars(
  prompt: string,
  globals: SnippetVariable[],
  userName: string,
  now: Date = new Date(),
): SubstitutionResult {
  const temporal = temporalVars(now);
  // Map keys → values. Built-ins go in first so a custom global with a
  // reserved key (which shouldn't be possible thanks to the server-side
  // check, but defense in depth) can't override them on the client.
  const table = new Map<string, string>();
  table.set("USER_NAME", userName);
  table.set("CURRENT_DATE", temporal.CURRENT_DATE);
  table.set("CURRENT_TIME", temporal.CURRENT_TIME);
  table.set("CURRENT_WEEKDAY", temporal.CURRENT_WEEKDAY);
  table.set("CURRENT_DATETIME", temporal.CURRENT_DATETIME);
  table.set("CURRENT_TIMEZONE", temporal.CURRENT_TIMEZONE);
  for (const v of globals) {
    if (!table.has(v.key)) table.set(v.key, v.value);
  }

  // Track unresolved keys in first-appearance order so the fill-dialog
  // input list reads top-down through the prompt. A plain Set would lose
  // insertion order on re-discovery; we de-dup against the running list.
  const unresolved: string[] = [];
  const resolved = prompt.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = table.get(key);
    if (value !== undefined) return value;
    if (!unresolved.includes(key)) unresolved.push(key);
    return `{{${key}}}`;
  });
  return { resolved, unresolved };
}

/**
 * Second pass: apply the values the user typed into the fill-blanks
 * dialog. Any keys still missing from `fills` survive as literal
 * `{{KEY}}` text so the model sees the placeholder rather than an empty
 * string — useful as a safety net if the dialog is ever bypassed.
 */
export function applyFillValues(
  prompt: string,
  fills: Record<string, string>,
): string {
  return prompt.replace(PLACEHOLDER_RE, (match, key: string) => {
    const v = fills[key];
    return v !== undefined ? v : match;
  });
}
