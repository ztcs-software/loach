import {
  Archive,
  ArchiveRestore,
  Layers,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

/**
 * Full-screen Archive view. Same layout rhythm as SnippetsView so the two
 * "secondary screens" feel like the same surface.
 */
export function ArchiveView() {
  const sessions = useChatStore((s) => s.sessions);
  const archive = useChatStore((s) => s.archive);
  const remove = useChatStore((s) => s.remove);
  const select = useChatStore((s) => s.selectSession);
  const setViewingArchive = useUIStore((s) => s.setViewingArchive);
  const setViewingSnippets = useUIStore((s) => s.setViewingSnippets);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);

  const archived = sessions
    .filter((s) => s.archived_at != null)
    .sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));

  const handleUnarchive = async (id: string) => {
    await archive(id, false);
  };

  const handleOpen = async (id: string) => {
    // Opening an archived chat surfaces it in the main view. It remains
    // archived — only the user's explicit Unarchive action changes that.
    setViewingArchive(false);
    setViewingSnippets(false);
    setViewingSpace(null);
    await select(id);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-8 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Archive
            </h1>
            <p className="mt-1.5 text-sm text-foreground/55">
              Chats you've moved out of the main list. Unarchive to bring them
              back, or delete permanently.
            </p>
          </div>
        </div>

        {archived.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 bg-foreground/[0.03]">
            {archived.map((s) => (
              <ArchivedRow
                key={s.id}
                session={s}
                onOpen={() => void handleOpen(s.id)}
                onUnarchive={() => void handleUnarchive(s.id)}
                onDelete={() => void remove(s.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-8 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.06] text-foreground/60">
        <Archive className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-lg font-medium">Nothing archived</h2>
      <p className="mt-1.5 max-w-md text-sm text-foreground/55">
        Right-click a chat in the sidebar (or open its ⋯ menu) and choose{" "}
        <em>Move to Archive</em> to stash it here without losing the history.
      </p>
    </div>
  );
}

function ArchivedRow({
  session,
  onOpen,
  onUnarchive,
  onDelete,
}: {
  session: Session;
  onOpen: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const archivedOn = session.archived_at
    ? new Date(session.archived_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";

  return (
    <li
      className={cn(
        "group flex items-center gap-3 px-4 py-3 transition-colors",
        "hover:bg-foreground/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">
          {session.title}
        </span>
        {session.space_id && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-foreground/55">
            <Layers className="h-2.5 w-2.5" />
            Space
          </span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-foreground/55">
          <Archive className="h-2.5 w-2.5" />
          Archived
        </span>
        <span className="shrink-0 text-[11px] text-foreground/40">
          {archivedOn}
        </span>
      </button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onUnarchive}
        className="h-8 gap-1.5 rounded-lg px-2.5 text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
      >
        <ArchiveRestore className="h-3.5 w-3.5" />
        Unarchive
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Archived chat actions"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[180px]"
        >
          <DropdownMenuItem
            onSelect={onUnarchive}
            className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
          >
            <ArchiveRestore className="h-4 w-4 text-foreground/60" />
            Unarchive
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onDelete}
            className="gap-2.5 px-3 py-2 text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
