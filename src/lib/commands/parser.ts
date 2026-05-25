import { COMMANDS } from "./registry";
import type { CommandSpec } from "./types";

/** Parsed leading-slash invocation. `name` is canonical (lowercase, no `/`).
 *  `rest` is everything after the first whitespace gap, preserved verbatim
 *  (including casing and inner whitespace) so commands like `/remember` can
 *  take free-form text. */
export interface ParsedCommand {
  name: string;
  rest: string;
}

/** True when the textarea content currently looks like a slash invocation
 *  the palette should react to. We only intercept when `/` is the very first
 *  character so a user pasting prose that contains `/` mid-line still sends
 *  normally. */
export function isCommandInput(text: string): boolean {
  return text.startsWith("/");
}

/** Parse the textarea contents into `(name, rest)` if it starts with `/`.
 *  Returns null otherwise. Does NOT validate against the registry — the
 *  composer relies on `findCommand` to decide whether to dispatch or fall
 *  through. */
export function parseInput(text: string): ParsedCommand | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  // Match the first run of non-whitespace as the command name, then the
  // remainder as a single rest-string. We deliberately do NOT split on every
  // space — commands like `/rename A title with spaces` want the whole tail.
  const m = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) {
    // `text === "/"` or `text === "/ "` etc. — still a command in progress,
    // surface as an empty-name parse so the palette can show all commands.
    return { name: "", rest: "" };
  }
  return { name: m[1]!.toLowerCase(), rest: (m[2] ?? "").trim() };
}

/** Look up a registered command by name. Exact match only — fuzzy matching
 *  belongs in the palette filter. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Suggestions for the autocomplete palette. Returns commands whose name
 *  starts with the typed prefix, plus any sub-command entries when the
 *  parent matches. Empty query (just `/`) returns every command. */
export function matchCommands(query: string): PaletteEntry[] {
  const parsed = parseInput("/" + query.replace(/^\/+/, ""));
  if (!parsed) return [];
  const name = parsed.name;
  const rest = parsed.rest;
  const out: PaletteEntry[] = [];
  for (const cmd of COMMANDS) {
    // Exact-name match + the user is typing an argument → suggest the
    // sub-commands as their own palette entries (`/list ` → `/list models`,
    // `/list snippets`, …).
    if (cmd.name === name && cmd.subcommands && cmd.subcommands.length > 0) {
      for (const sub of cmd.subcommands) {
        if (sub.startsWith(rest.toLowerCase())) {
          out.push({
            cmd,
            sub,
            display: `/${cmd.name} ${sub}`,
            insertText: `/${cmd.name} ${sub}`,
            description: cmd.description,
          });
        }
      }
      continue;
    }
    // Otherwise filter by prefix on the canonical name.
    if (cmd.name.startsWith(name) && rest.length === 0) {
      out.push({
        cmd,
        sub: null,
        display: `/${cmd.name}${cmd.usage ? " " + cmd.usage : ""}`,
        insertText: `/${cmd.name}${cmd.subcommands?.length ? " " : cmd.usage ? " " : ""}`,
        description: cmd.description,
      });
    }
  }
  return out;
}

export interface PaletteEntry {
  cmd: CommandSpec;
  /** Selected sub-command, when this entry was synthesised from one. */
  sub: string | null;
  /** Text shown in the palette row (e.g. `/list models`). */
  display: string;
  /** Text inserted into the textarea when the entry is accepted. */
  insertText: string;
  description: string;
}
