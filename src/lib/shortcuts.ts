/**
 * Global keyboard shortcuts — single source of truth.
 *
 * The list below drives both the window-level keydown handler in
 * `KeyboardShortcuts` and the help dialog (`ShortcutListDialog`). Keeping
 * them co-located guarantees the labels users see match the keys we
 * actually listen for.
 *
 * Platform mapping: the "primary" modifier is Cmd on macOS and Ctrl on
 * Windows/Linux (see `primaryMod`). JavaScript's `event.metaKey` covers Cmd,
 * `event.ctrlKey` covers Ctrl.
 */

/** True when running on macOS — detected from `navigator.userAgentData`
 *  (Chromium) or the legacy `navigator.platform`. Picks the key labels and
 *  which key `primaryMod` reads. */
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
    label: "Search chats, messages, Spaces, snippets, Library",
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

/** Is the primary modifier held? Cmd alone on macOS: Ctrl there belongs to
 *  the text field, where WebKit honours Cocoa's bindings (Ctrl+K kills to
 *  the end of the line, Ctrl+N / Ctrl+F move the caret). Elsewhere Ctrl, or
 *  Cmd from a Mac keyboard. */
export function primaryMod(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey || e.metaKey;
}

/**
 * The one Enter rule for create/edit dialogs: Enter in a one-line field, or
 * Ctrl/⌘+Enter in a multi-line one, submits once the form is `ready` — and
 * before that moves on to `next`, the field still to fill. Each dialog used
 * to pick its own (Enter saved a Space but did nothing in a snippet's title).
 * Returns whether it handled the key.
 */
export function dialogEnter(
  e: {
    key: string;
    shiftKey: boolean;
    currentTarget: HTMLElement;
    nativeEvent: KeyboardEvent;
    preventDefault: () => void;
  },
  submit: () => void,
  opts: { ready: boolean; next?: HTMLElement | null },
): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  // The Enter that confirms an IME candidate isn't the form's.
  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;
  if (e.currentTarget.tagName === "TEXTAREA" && !primaryMod(e.nativeEvent)) return false;
  e.preventDefault();
  if (opts.ready) submit();
  else opts.next?.focus();
  return true;
}

/** The Latin key at this key's position: `KeyK` → "k", `Digit7` → "7",
 *  `Slash` → "/". */
function keyFromCode(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (m) return (m[1] ?? m[2]).toLowerCase();
  return code === "Slash" ? "/" : null;
}

/** Does this keyboard event match the spec? `mod` is `primaryMod`. Strict on
 *  Shift (must match exactly) so Ctrl+S and Ctrl+Shift+S don't collide —
 *  except on a punctuation key, whose character may itself need Shift: `/`
 *  is Shift+7 on German and Nordic layouts, Shift+: on French. Strict on
 *  Alt/Option (must not be pressed) so Ctrl+Alt+K doesn't accidentally
 *  trigger Ctrl+K.
 *
 *  A layout without Latin letters (Cyrillic, Greek) reports its own
 *  character in `e.key`, so a non-ASCII key falls back to the key's position
 *  in `e.code` — the key the shortcut labels name. */
export function matches(spec: ShortcutSpec, e: KeyboardEvent): boolean {
  const mod = primaryMod(e);
  if (spec.mod !== mod) return false;
  if (e.altKey) return false;
  let k = e.key.toLowerCase();
  if (e.key.length === 1 && e.key.charCodeAt(0) > 0x7f) k = keyFromCode(e.code) ?? k;
  if (!spec.keys.some((target) => target.toLowerCase() === k)) return false;
  const punctuation = k.length === 1 && !/[a-z0-9]/.test(k);
  return spec.shift ? e.shiftKey : !e.shiftKey || punctuation;
}

/** Is a modal dialog open? Radix dialogs mark their content `role="dialog"`
 *  with `data-state="open"`; the hand-rolled overlays (the Ctrl/Cmd+K
 *  palette, Private Chat, onboarding) set `aria-modal`. The context-usage
 *  popover is a `role="dialog"` with neither, and doesn't block the app. */
export function modalDialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]',
  );
}

/** Renders a spec as a human-readable label, e.g. "⌘K" on macOS or
 *  "Ctrl K" on Windows/Linux. Used by both the title bar pill and the
 *  shortcut-list dialog. */
export function formatShortcut(
  spec: Pick<ShortcutSpec, "mod" | "shift" | "keys">,
): string {
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
