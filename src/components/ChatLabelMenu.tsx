import { Check, Tag } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { CHAT_LABELS, findChatLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { ChatLabel } from "@/types";

/** The colour dot for a labelled chat. Renders nothing when the chat is
 *  unlabelled — or when the stored id isn't in our palette, which only a
 *  hand-edited snapshot import can produce.
 *
 *  Callers place this first in the row so the order reads LABEL · ICON ·
 *  NAME: the dot marks the whole chat, so it sits outside the pin/fork/space
 *  icon rather than displacing it. Spacing is left to the caller — the
 *  sidebar row uses per-icon margins, SpaceView's uses a flex `gap`. */
export function ChatLabelDot({
  label,
  className,
}: {
  label: ChatLabel | null;
  className?: string;
}) {
  const def = findChatLabel(label);
  if (!def) return null;
  return (
    <span
      role="img"
      aria-label={`Label: ${def.name}`}
      style={{ backgroundColor: def.color }}
      className={cn("h-2 w-2 shrink-0 rounded-full", className)}
    />
  );
}

/** "Label ▸" submenu: the palette plus a clear-it item. Drop it into any
 *  chat kebab's `DropdownMenuContent`.
 *
 *  `iconClassName` exists because the two menu styles in the app space their
 *  item icons differently — the sidebar leans on `DropdownMenuItem`'s own
 *  `gap-2`, while SpaceView and ChatHeader add `mr-2` on top. */
export function ChatLabelSubmenu({
  value,
  onSelect,
  iconClassName = "h-4 w-4",
}: {
  value: ChatLabel | null;
  onSelect: (label: ChatLabel | null) => void;
  iconClassName?: string;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Tag className={iconClassName} />
        Label
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {CHAT_LABELS.map((l) => (
          <DropdownMenuItem key={l.id} onSelect={() => onSelect(l.id)}>
            <span
              aria-hidden
              style={{ backgroundColor: l.color }}
              className="h-3 w-3 shrink-0 rounded-full"
            />
            {l.name}
            {value === l.id && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSelect(null)} disabled={!value}>
          <span
            aria-hidden
            className="h-3 w-3 shrink-0 rounded-full border border-dashed border-foreground/40"
          />
          No label
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
