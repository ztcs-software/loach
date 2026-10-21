import { Check, Layers } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";
import type { Session } from "@/types";

/** "Move to Space ▸" submenu: every Space, plus taking the chat out of the
 *  one it's in. Drop it into any chat kebab's `DropdownMenuContent` — the
 *  sidebar row, a Space's chat list and the chat header all carry it, so a
 *  chat started outside a Space can join one later and vice versa.
 *
 *  Unlike `ChatLabelSubmenu` it does the move itself: every caller would
 *  otherwise repeat the same toast for where the chat went.
 *
 *  `iconClassName` follows `ChatLabelSubmenu`'s: the sidebar leans on
 *  `DropdownMenuItem`'s own gap, SpaceView and ChatHeader add `mr-2`. */
export function ChatSpaceSubmenu({
  session,
  iconClassName = "h-4 w-4",
}: {
  session: Pick<Session, "id" | "space_id">;
  iconClassName?: string;
}) {
  const spaces = useSpaceStore((s) => s.spaces);
  const moveToSpace = useChatStore((s) => s.moveToSpace);

  const move = async (spaceId: string | null) => {
    if (spaceId === session.space_id) return;
    const toast = useToastStore.getState().push;
    try {
      await moveToSpace(session.id, spaceId);
    } catch (e) {
      toast({
        kind: "error",
        title: "Couldn't move this chat",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const name = spaces.find((sp) => sp.id === spaceId)?.name;
    toast({
      kind: "info",
      title: name ? `Moved to “${name}”` : "Moved out of its Space",
      body: name
        ? "From its next message it uses this Space's instructions, sources and memory."
        : "From its next message it no longer uses the Space's instructions, sources or memory.",
    });
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Layers className={iconClassName} />
        Move to Space
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 min-w-[180px] overflow-y-auto">
        {spaces.length === 0 && <DropdownMenuItem disabled>No Spaces yet</DropdownMenuItem>}
        {spaces.map((sp) => (
          <DropdownMenuItem key={sp.id} onSelect={() => void move(sp.id)}>
            <span className="min-w-0 truncate">{sp.name}</span>
            {session.space_id === sp.id && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
        {session.space_id && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void move(null)}>Remove from Space</DropdownMenuItem>
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
