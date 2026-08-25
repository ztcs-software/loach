import type { PaletteEntry } from "./parser";

/**
 * Most-recently-used tracking for slash commands.
 *
 * The list is persisted as a JSON string in the KV settings table
 * (`recent_commands`) — the same place `default_provider` / `default_model`
 * keep "last used" state that never appears in the Settings dialog. It has
 * to survive a restart to be worth anything: a session-scoped list only
 * starts helping after you've already run the command once that launch,
 * which is precisely the moment you didn't need help.
 *
 * Everything here is pure so the ordering can be unit-tested without a
 * store or a rendered palette.
 */

/** How many names we keep on disk. */
export const RECENT_COMMANDS_MAX = 6;

/** How many of them the palette hoists into its "Recent" section. Smaller
 *  than MAX so the section stays a shortcut rather than a second copy of
 *  the whole list. */
export const RECENT_COMMANDS_SHOWN = 4;

/** Group label used for hoisted entries. Matches the header vocabulary the
 *  palette already renders for registry groups. */
export const RECENT_GROUP = "Recent";

/** Decode the stored list. Total garbage in (hand-edited snapshot, older
 *  format) yields an empty list rather than throwing — a broken recency
 *  hint must never take the composer down with it. */
export function parseRecentCommands(encoded: string): string[] {
  if (!encoded) return [];
  try {
    const v: unknown = JSON.parse(encoded);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .slice(0, RECENT_COMMANDS_MAX);
  } catch {
    return [];
  }
}

/** Move `name` to the head of the stored list and re-encode. Returns the
 *  input unchanged when that would be a no-op, so callers can skip the
 *  write (and the re-render) on a repeat of the same command. */
export function pushRecentCommand(encoded: string, name: string): string {
  const prev = parseRecentCommands(encoded);
  const next = [name, ...prev.filter((n) => n !== name)].slice(
    0,
    RECENT_COMMANDS_MAX,
  );
  const out = JSON.stringify(next);
  return out === encoded ? encoded : out;
}

/**
 * Float the user's recent commands to the top of a palette result set,
 * tagged into a "Recent" group.
 *
 * Two rules keep this from fighting the palette's group headers:
 *   - hoisted entries move as a contiguous block at index 0, so every
 *     group (including this one) stays contiguous and each header renders
 *     exactly once;
 *   - sub-command rows (`/list models`) never hoist. They only appear when
 *     the parent command was typed in full, so every row would share one
 *     `cmd.name` and a matching parent would hoist the entire list under a
 *     pointless "Recent" header.
 */
export function orderByRecency(
  entries: PaletteEntry[],
  recent: readonly string[],
): PaletteEntry[] {
  if (entries.length < 2 || recent.length === 0) return entries;

  const rank = new Map(recent.map((name, i) => [name, i]));
  const hoisted = entries
    .filter((e) => e.sub === null && rank.has(e.cmd.name))
    .sort((a, b) => rank.get(a.cmd.name)! - rank.get(b.cmd.name)!)
    .slice(0, RECENT_COMMANDS_SHOWN);
  if (hoisted.length === 0) return entries;

  // Built from the ORIGINAL objects, before the copies below — identity is
  // what the filter matches on.
  const lifted = new Set(hoisted);
  return [
    ...hoisted.map((e) => ({ ...e, groupOverride: RECENT_GROUP })),
    ...entries.filter((e) => !lifted.has(e)),
  ];
}
