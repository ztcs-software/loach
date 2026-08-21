import type { ChatLabel } from "@/types";

export interface ChatLabelDef {
  id: ChatLabel;
  name: string;
  /** Dot colour. Tailwind 500-level hues: mid-lightness, so an 8px dot stays
   *  legible against both the near-white light sidebar and the near-black
   *  dark one without needing a per-theme value. */
  color: string;
}

/** The palette offered in the "Label" submenu, in menu order. Hues are spread
 *  wide enough (0 / 38 / 142 / 217 / 271 / 330) to stay distinguishable at
 *  dot size. */
export const CHAT_LABELS: ChatLabelDef[] = [
  { id: "red", name: "Red", color: "#ef4444" },
  { id: "amber", name: "Amber", color: "#f59e0b" },
  { id: "green", name: "Green", color: "#22c55e" },
  { id: "blue", name: "Blue", color: "#3b82f6" },
  { id: "purple", name: "Purple", color: "#a855f7" },
  { id: "pink", name: "Pink", color: "#ec4899" },
];

/** Palette entry for a stored label id, or undefined when the id isn't one we
 *  ship. Snapshot import can carry a hand-edited value, so callers render
 *  nothing rather than break the row. */
export function findChatLabel(
  id: string | null | undefined,
): ChatLabelDef | undefined {
  return id ? CHAT_LABELS.find((l) => l.id === id) : undefined;
}
