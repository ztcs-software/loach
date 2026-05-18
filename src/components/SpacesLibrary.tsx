import { useMemo, useState } from "react";
import {
  Layers,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn, relativeTime } from "@/lib/utils";
import type { Space } from "@/types";

/**
 * Full-canvas browse surface for Spaces. Mirrors SnippetsLibrary in shape so
 * the two surfaces feel like the same place — same header, same search bar,
 * same tile grid. The dominant action here is `Open` (drop into the Space's
 * detail view), so that's the primary button on each tile.
 *
 * Reached via the "Spaces" rail tab in the sidebar — when active the sidebar
 * collapses to the icon rail so the library is the only thing competing for
 * the user's attention. See `App.tsx` for the routing decision.
 */
export function SpacesLibrary() {
  const { confirm } = useConfirm();
  const spaces = useSpaceStore((s) => s.spaces);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setFormOpen = useSpaceStore((s) => s.setSpaceFormOpen);
  const removeSpace = useSpaceStore((s) => s.deleteSpace);
  const sessions = useChatStore((s) => s.sessions);
  const newSession = useChatStore((s) => s.newSession);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);

  // Per-space chat counts (live conversations only — archived chats aren't a
  // useful "freshness" signal). Memoized once per session list so we don't
  // re-walk the array per tile render.
  const chatCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of sessions) {
      if (s.archived_at) continue;
      if (!s.space_id) continue;
      counts[s.space_id] = (counts[s.space_id] ?? 0) + 1;
    }
    return counts;
  }, [sessions]);

  const sorted = useMemo(
    () => [...spaces].sort((a, b) => b.updated_at - a.updated_at),
    [spaces],
  );

  const handleDelete = async (space: Space) => {
    const ok = await confirm({
      title: `Delete space “${space.name}”?`,
      body: "Files and instructions in this space will be removed. Chats inside the space stay, but they lose their space association.",
      confirmLabel: "Delete space",
      destructive: true,
    });
    if (ok) void removeSpace(space.id);
  };

  // Land on the chats canvas first so the new session's composer has a place
  // to render, then create the session bound to this space. The setViewingSpace
  // call clears any leftover space-detail state — we don't want to drop into
  // SpaceView, we want the chat itself.
  const newChatInSpace = (space: Space) => {
    setViewingSpace(null);
    setSidebarTab("chats");
    void newSession({ spaceId: space.id });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-8 py-8">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight text-foreground">
                <Layers className="h-6 w-6 text-foreground/60" />
                Spaces
              </h1>
              <p className="mt-2 max-w-xl text-sm text-foreground/55">
                Group chats around a project. Chats inside Spaces share
                instructions, reference files and memory. Perfect for ongoing
                work that needs context every time.
              </p>
            </div>
            <Button
              onClick={() => setFormOpen(true)}
              className="gap-1.5 rounded-xl"
            >
              <Plus className="h-4 w-4" />
              New space
            </Button>
          </header>

          {spaces.length === 0 ? (
            <EmptyLibraryState
              icon={<Layers className="h-7 w-7 text-foreground/45" />}
              title="No spaces yet"
              description="Create a space for a project, a topic, or a long-running thread of work. Drop in reference files and Loach will pull from them in every chat inside the space."
              cta={
                <Button
                  onClick={() => setFormOpen(true)}
                  className="gap-1.5 rounded-xl"
                >
                  <Plus className="h-4 w-4" />
                  Create your first space
                </Button>
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sorted.map((space) => (
                <SpaceCard
                  key={space.id}
                  space={space}
                  chatCount={chatCounts[space.id] ?? 0}
                  onOpen={() => setViewingSpace(space.id)}
                  onNewChat={() => newChatInSpace(space)}
                  onDelete={() => handleDelete(space)}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

function SpaceCard({
  space,
  chatCount,
  onOpen,
  onNewChat,
  onDelete,
}: {
  space: Space;
  chatCount: number;
  /** Tile body click + kebab "Open / edit" both use this — drops the user
   *  into SpaceView for the space's instructions / files / chat list. */
  onOpen: () => void;
  /** Footer button — creates a fresh chat scoped to this space and lands
   *  the user on the chat canvas. */
  onNewChat: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasInstructions = space.instructions.trim().length > 0;
  // "Clickable card with nested menu" is a WAI-flagged pattern (interactive
  // descendants inside an interactive parent). We accept the trade-off
  // here because the alternative — a stretched-link overlay button — adds
  // a separate tab stop per tile that does nothing useful. To keep screen
  // readers from getting confused, the parent uses `role="button"` with an
  // explicit aria-label naming the space, the kebab button below uses
  // `aria-label="Space actions"` and `e.stopPropagation()` so it doesn't
  // double-fire `onOpen`, and the menu items announce themselves
  // individually via their own labels.
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open space: ${space.name}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex h-full cursor-pointer flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.025]",
        "p-5 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      {/* Title + actions menu */}
      <header className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 flex-1 text-[15px] font-semibold text-foreground/90">
          {space.name}
        </h3>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Space actions"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "-m-1 rounded-md p-1 text-foreground/45 transition-opacity hover:bg-foreground/10 hover:text-foreground",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onOpen}>
              <Pencil className="h-4 w-4" /> Open / edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Description (or a quiet placeholder when empty so cards stay aligned) */}
      <p
        className={cn(
          "mt-2 line-clamp-3 text-[13px] leading-relaxed",
          space.description ? "text-foreground/60" : "italic text-foreground/35",
        )}
      >
        {space.description || "No description"}
      </p>

      <div className="flex-1" />

      {/* Footer: meta on the left, Open on the right */}
      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
        <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-foreground/45">
          <span
            className="inline-flex items-center gap-1 truncate"
            title={`${chatCount} live chat${chatCount === 1 ? "" : "s"} in this space`}
          >
            <MessageSquareText className="h-3 w-3 shrink-0" />
            {chatCount}
          </span>
          {hasInstructions && (
            <>
              <span aria-hidden className="text-foreground/25">
                ·
              </span>
              <span className="truncate" title="Has custom instructions">
                Instructions
              </span>
            </>
          )}
          <span aria-hidden className="text-foreground/25">
            ·
          </span>
          <span
            className="truncate"
            title={new Date(space.updated_at).toLocaleString()}
          >
            {relativeTime(space.updated_at)}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            // Stop propagation so the tile-level onClick doesn't ALSO
            // navigate to the SpaceView — the user wants the chat canvas,
            // not the space's detail page.
            e.stopPropagation();
            onNewChat();
          }}
          className="h-8 gap-1 rounded-lg px-3 text-xs"
        >
          <SquarePen className="h-3 w-3" />
          New chat
        </Button>
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Shared empty state — visual mirror of SnippetsLibrary's so the surfaces
// feel like the same place in two outfits.
// ---------------------------------------------------------------------------

function EmptyLibraryState({
  icon,
  title,
  description,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  cta?: React.ReactNode;
}) {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center justify-center rounded-3xl border border-dashed border-foreground/10 bg-foreground/[0.015] px-8 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-foreground/[0.05]">
        {icon}
      </div>
      <h2 className="text-base font-semibold text-foreground/85">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-foreground/55">
        {description}
      </p>
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  );
}
