/**
 * Global keyboard shortcuts — single source of truth.
 *
 * The list below drives both the window-level keydown handler in
 * `KeyboardShortcuts` and the help dialog (`ShortcutListDialog`). Keeping
 * them co-located guarantees the labels users see match the keys we
 * actually listen for.
 *
 * Platform mapping: we treat Ctrl on Windows/Linux and Cmd on macOS as the
 * same logical "primary" modifier. JavaScript's `event.metaKey` covers Cmd,
 * `event.ctrlKey` covers Ctrl; the handler accepts either.
 */

/** True when running on macOS — detected from `navigator.userAgentData`
 *  (Chromium) or the legacy `navigator.platform`. Pure cosmetic + key-label
 *  use; the shortcut matcher itself is platform-agnostic (Ctrl ≡ Cmd). */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform || navigator.platform,
  );

/** Action id — used as the key in switch/dispatch tables and in the help
 *  dialog. Not user-visible. */
export type ShortcutAction =
  | "global-search"
  | "new-chat"
  | "find-in-chat"
  | "open-uploads"
  | "toggle-sidebar"
  | "toggle-params"
  | "delete-current-chat"
  | "lock-now"
  | "show-shortcuts";

/** Where a shortcut belongs in the help dialog. */
export type ShortcutGroup =
  | "Navigation"
  | "Chat"
  | "Layout"
  | "Security"
  | "Help";

/** Canonical, platform-independent description of a shortcut. The `mod`
 *  flag stands for Ctrl-on-PC / Cmd-on-Mac (the conventional primary
 *  modifier); `shift` is literal Shift; `key` is `event.key` (case-
 *  insensitive). */
export interface ShortcutSpec {
  action: ShortcutAction;
  /** User-facing label, e.g. "New chat". */
  label: string;
  /** Help-dialog group. */
  group: ShortcutGroup;
  mod: boolean;
  shift?: boolean;
  /** event.key value(s) accepted (case-insensitive). Multiple entries means
   *  any of them triggers — used for Backspace/Delete on macOS. */
  keys: string[];
}

/** The full shortcut table. Order here is the order shown in the help
 *  dialog within each group. */
export const SHORTCUTS: ShortcutSpec[] = [
  // Navigation
  {
    action: "global-search",
    label: "Search chats, spaces, snippets",
    group: "Navigation",
    mod: true,
    keys: ["k"],
  },
  {
    action: "new-chat",
    label: "New chat",
    group: "Navigation",
    mod: true,
    keys: ["n"],
  },
  // Chat
  {
    action: "find-in-chat",
    label: "Find in current chat",
    group: "Chat",
    mod: true,
    keys: ["f"],
  },
  {
    action: "open-uploads",
    label: "Attach files",
    group: "Chat",
    mod: true,
    keys: ["u"],
  },
  {
    action: "delete-current-chat",
    label: "Delete current chat",
    group: "Chat",
    mod: true,
    shift: true,
    keys: ["Backspace", "Delete"],
  },
  // Layout
  {
    action: "toggle-sidebar",
    label: "Show / hide left sidebar",
    group: "Layout",
    mod: true,
    shift: true,
    keys: ["s"],
  },
  {
    action: "toggle-params",
    label: "Show / hide parameters panel",
    group: "Layout",
    mod: true,
    shift: true,
    keys: ["p"],
  },
  // Security
  {
    action: "lock-now",
    label: "Lock Loach now",
    group: "Security",
    mod: true,
    shift: true,
    keys: ["l"],
  },
  // Help
  {
    action: "show-shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    mod: true,
    keys: ["/"],
  },
];

/** Does this keyboard event match the spec? Accepts either Ctrl or Cmd as
 *  the primary modifier — JS distinguishes them (`ctrlKey` vs `metaKey`)
 *  but the app treats them as one. Strict on Shift (must match exactly) so
 *  Ctrl+S and Ctrl+Shift+S don't collide. Strict on Alt/Option (must not
 *  be pressed) so Ctrl+Alt+K doesn't accidentally trigger Ctrl+K. */
export function matches(spec: ShortcutSpec, e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (spec.mod !== mod) return false;
  if (!!spec.shift !== e.shiftKey) return false;
  if (e.altKey) return false;
  const k = e.key.toLowerCase();
  return spec.keys.some((target) => target.toLowerCase() === k);
}

/** Renders a spec as a human-readable label, e.g. "⌘K" on macOS or
 *  "Ctrl K" on Windows/Linux. Used by both the title bar pill and the
 *  shortcut-list dialog. */
export function formatShortcut(spec: ShortcutSpec): string {
  const parts: string[] = [];
  if (spec.mod) parts.push(IS_MAC ? "⌘" : "Ctrl");
  if (spec.shift) parts.push(IS_MAC ? "⇧" : "Shift");
  const k = spec.keys[0];
  // Pretty-print the primary key. macOS conventionally uses single-glyph
  // labels for arrows and special keys; on PC we spell them out so the
  // hint stays legible.
  const pretty = prettyKey(k);
  parts.push(pretty);
  return IS_MAC ? parts.join("") : parts.join(" ");
}

function prettyKey(key: string): string {
  switch (key) {
    case "Backspace":
      return IS_MAC ? "⌫" : "Backspace";
    case "Delete":
      return IS_MAC ? "⌦" : "Delete";
    case "/":
      return "/";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}
