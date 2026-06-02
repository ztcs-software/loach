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
  //
  // A variable's value may itself contain `{{KEY}}` placeholders, so we
  // expand to a fixed point rather than in a single pass — otherwise a
  // value like `"Hello {{NAME}}"` would leave a literal `{{NAME}}` in the
  // output AND never report it as unresolved (the old single-pass code did
  // exactly that). The `expanded` set caps each key to one substitution,
  // which both bounds the work and makes cycles (`A → {{B}}`, `B → {{A}}`)
  // and self-reference (`FOO → "{{FOO}}"`) terminate; anything still
  // present after the loop is reported as unresolved so the caller can
  // prompt for it rather than leaking the literal to the model.
  //
  // Note an EMPTY global value still substitutes (to ""), NOT treated as
  // unresolved: a global explicitly saved empty means "expand to nothing"
  // (the variables panel renders that as a valid "(empty)" state). Only a
  // *missing* key — no global and no built-in — is unresolved and routed to
  // the fill dialog. `table.get` returns undefined for missing vs "" for an
  // empty global, so the two stay distinct.
  const MAX_PASSES = 8;
  const unresolved: string[] = [];
  const expanded = new Set<string>();
  let resolved = prompt;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let substituted = false;
    resolved = resolved.replace(PLACEHOLDER_RE, (_match, key: string) => {
      if (expanded.has(key)) return `{{${key}}}`;
      const value = table.get(key);
      if (value !== undefined) {
        expanded.add(key);
        substituted = true;
        return value;
      }
      // Unknown key → leave the placeholder for the fill dialog.
      return `{{${key}}}`;
    });
    if (!substituted) break;
  }
  // Record whatever is still unresolved after the fixed-point loop, in
  // first-appearance order. Re-scanning the final string (rather than
  // collecting during substitution) means a key only counts as unresolved
  // if it actually survives all passes.
  for (const m of resolved.matchAll(PLACEHOLDER_RE)) {
    const key = m[1];
    if (!unresolved.includes(key)) unresolved.push(key);
  }
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
