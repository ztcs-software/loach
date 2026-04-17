import { useMemo, useState } from "react";
import { Layers, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import type { Space } from "@/types";

/**
 * Full-screen Spaces browser — surfaced from the "← All spaces" link inside
 * a space, from the sidebar grid affordance, and used as a fallback target
 * when the user leaves a space. Design is deliberately parallel to
 * `SnippetsView`: same header rhythm, same card grid, so the secondary
 * screens feel like one family.
 */
export function SpacesView() {
  const spaces = useSpaceStore((s) => s.spaces);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setSpaceFormOpen = useSpaceStore((s) => s.setSpaceFormOpen);
  const removeSpace = useSpaceStore((s) => s.deleteSpace);
  const setViewingSpacesList = useUIStore((s) => s.setViewingSpacesList);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"activity" | "created" | "name">("activity");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? spaces.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
      : spaces;
    const sorted = [...base].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "created") return b.created_at - a.created_at;
      return b.updated_at - a.updated_at;
    });
    return sorted;
  }, [spaces, query, sort]);

  const handleOpen = (space: Space) => {
    setViewingSpacesList(false);
    setViewingSpace(space.id);
  };

  const handleDelete = async (space: Space) => {
    // The store itself clears viewingSpaceId when the deleted space matches.
    await removeSpace(space.id);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        {/* ─── Header ─── */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Spaces
            </h1>
            <p className="mt-1.5 text-sm text-foreground/55">
              Group related chats with shared instructions and reference files.
              Pick one to continue, or create a new space for a new topic.
            </p>
          </div>
          <Button
            onClick={() => setSpaceFormOpen(true)}
            className="shrink-0 gap-1.5 rounded-xl"
          >
            <Plus className="h-4 w-4" />
            New space
          </Button>
        </div>

        {/* ─── Search + sort row ─── */}
        {spaces.length > 0 && (
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search spaces…"
                className="h-10 rounded-xl border-foreground/10 bg-foreground/[0.04] pl-9 text-sm"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-foreground/55">
              <span>Sort by</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.04] px-2.5 text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
                  >
                    {SORT_LABEL[sort]}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[140px]">
                  {(Object.keys(SORT_LABEL) as (keyof typeof SORT_LABEL)[]).map(
                    (k) => (
                      <DropdownMenuItem key={k} onSelect={() => setSort(k)}>
                        {SORT_LABEL[k]}
                      </DropdownMenuItem>
                    ),
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}

        {/* ─── Grid / empty state ─── */}
        {spaces.length === 0 ? (
          <EmptyState onCreate={() => setSpaceFormOpen(true)} />
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-6 py-10 text-center text-sm text-foreground/55">
            No spaces match "{query}".
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((space) => (
              <SpaceTile
                key={space.id}
                space={space}
                onOpen={() => handleOpen(space)}
                onEdit={() => {
                  // Reuse the in-space edit UI — opening the space is enough
                  // since the SpaceView surfaces name/description/instructions
                  // inline. Matches the SpaceList row behaviour.
                  setViewingSpacesList(false);
                  setViewingSpace(space.id);
                }}
                onDelete={() => void handleDelete(space)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SORT_LABEL = {
  activity: "Last activity",
  created: "Date created",
  name: "Name",
} as const;

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-8 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.06] text-foreground/60">
        <Layers className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-lg font-medium">No spaces yet</h2>
      <p className="mt-1.5 max-w-md text-sm text-foreground/55">
        Spaces keep a theme's chats, instructions, and reference files
        together — think "tax advisor", "photo critique", "French tutor".
      </p>
      <Button onClick={onCreate} className="mt-5 gap-1.5 rounded-xl">
        <Plus className="h-4 w-4" />
        Create your first space
      </Button>
    </div>
  );
}

function SpaceTile({
  space,
  onOpen,
  onEdit,
  onDelete,
}: {
  space: Space;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex min-h-[180px] cursor-pointer flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.04] p-5 transition-colors",
        "hover:border-foreground/20 hover:bg-foreground/[0.06]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {/* Title row with ⋯ menu */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {space.name}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Space actions"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
            className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[140px]"
          >
            <DropdownMenuItem
              onSelect={onEdit}
              className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
            >
              <Pencil className="h-4 w-4 text-foreground/60" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onDelete}
              className="gap-2.5 px-3 py-2 text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Description */}
      <p
        className={cn(
          "mb-4 line-clamp-3 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed",
          space.description ? "text-foreground/65" : "italic text-foreground/35",
        )}
      >
        {space.description || "No description"}
      </p>

      {/* Footer — creation date */}
      <div className="flex items-center justify-between text-[11px] text-foreground/40">
        <span>Created {formatDate(space.created_at)}</span>
        <span>Updated {relativeLabel(space.updated_at)}</span>
      </div>
    </div>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Human-friendly "2 days ago" / "just now" for the tile footer. */
function relativeLabel(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} mo ago`;
  return `${Math.floor(diff / (365 * day))} y ago`;
}
