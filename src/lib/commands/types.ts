// Slash-command public surface. The chat composer parses leading-slash input
// against this layer; everything else (palette UI, dispatcher, individual
// handlers) is wired up through these types.

export interface CommandSpec {
  /** Canonical name (no leading slash, lowercase). */
  name: string;
  /** Short noun-phrase shown in the palette next to the name. */
  description: string;
  /** Optional argument hint shown after the name, e.g. "<title>" or "on|off". */
  usage?: string;
  /** Sub-commands shown as their own palette entries when the user types the
   *  parent. Example: `/list models`, `/list snippets`. The handler still
   *  receives the raw rest-string and decides what to do with it. */
  subcommands?: readonly string[];
  /** Category label used by the `/help` dialog to group commands into
   *  scannable sections. Omit to land in the trailing "Other" bucket. */
  group?: string;
}

/** Outcome of running a command. The composer treats each variant differently
 *  — toasts for confirmations, the result panel for lists, an inline error
 *  pill for rejected calls. */
export type CommandResult =
  | { kind: "toast"; title: string; body?: string; tone?: "info" | "error" }
  | { kind: "list"; title: string; items: CommandResultItem[] }
  | { kind: "noop" };

export interface CommandResultItem {
  /** Primary label — model id, persona name, snippet title. */
  label: string;
  /** Optional muted right-hand detail — provider, fact id, status. */
  detail?: string;
  /** Optional explanatory subtitle under the label. */
  hint?: string;
}
