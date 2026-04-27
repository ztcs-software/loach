import { useMemo, useState } from "react";
import {
  Cpu,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn, relativeTime } from "@/lib/utils";
import type { Snippet } from "@/types";

/**
 * Full-canvas browse-and-act surface for saved prompts. Each snippet is a
 * tile with a prominent `Run` button so the dominant action (start a chat
 * pre-filled with this prompt) is always one click away. Edit / Delete sit
 * behind a `⋯` menu so they don't compete visually.
 *
 * Reached via the "Snippets" rail tab in the sidebar — when that tab is
 * active the sidebar collapses to its icon rail and this view fills the
 * canvas. See `App.tsx` for the routing.
 */
export function SnippetsLibrary() {
  const snippets = useSnippetStore((s) => s.snippets);
  const openDialog = useSnippetStore((s) => s.openDialog);
  const remove = useSnippetStore((s) => s.remove);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const primeComposer = useUIStore((s) => s.primeComposer);

  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const sorted = [...snippets].sort((a, b) => b.updated_at - a.updated_at);
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        (s.model?.toLowerCase().includes(q) ?? false),
    );
  }, [snippets, query]);

  const runSnippet = async (snippet: Snippet) => {
    // Land the user on the chats canvas so primeComposer's draft has a place
    // to render. Without this the new session would mount under the still-
    // active "snippets" tab and the chat surface would never appear.
    setViewingSpace(null);
    setSidebarTab("chats");
    await newSession({
      spaceId: null,
      provider: snippet.provider ?? undefined,
      model: snippet.model ?? undefined,
    });
    primeComposer(snippet.prompt, []);
  };

  const handleDelete = (snippet: Snippet) => {
    if (
      confirm(
        `Delete snippet "${snippet.title}"? This cannot be undone.`,
      )
    ) {
      void remove(snippet.id);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-8 py-8">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight text-foreground">
                <Sparkles className="h-6 w-6 text-foreground/60" />
                Snippets
              </h1>
              <p className="mt-2 max-w-xl text-sm text-foreground/55">
                Reusable prompts. Hit{" "}
                <span className="font-medium text-foreground/80">Run</span> on
                any tile to start a fresh chat with the prompt pre-filled —
                and, if pinned, the right model already selected.
              </p>
            </div>
            <Button
              onClick={() => openDialog("new")}
              className="gap-1.5 rounded-xl"
            >
              <Plus className="h-4 w-4" />
              New snippet
            </Button>
          </header>

          {snippets.length > 0 && (
            <div className="relative mb-6 max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search snippets…"
                className="h-10 rounded-xl border-foreground/10 bg-foreground/[0.04] pl-9 text-sm"
              />
            </div>
          )}

          {snippets.length === 0 ? (
            <EmptyLibraryState
              icon={<Sparkles className="h-7 w-7 text-foreground/45" />}
              title="No snippets yet"
              description="Save a prompt you send often — code review checklists, summary templates, persona setups — and run it with one click later."
              cta={
                <Button
                  onClick={() => openDialog("new")}
                  className="gap-1.5 rounded-xl"
                >
                  <Plus className="h-4 w-4" />
                  Create your first snippet
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <p className="px-3 py-12 text-center text-sm text-foreground/50">
              No snippets match{" "}
              <span className="font-medium text-foreground/70">
                "{query}"
              </span>
              .
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((snippet) => (
                <SnippetCard
                  key={snippet.id}
                  snippet={snippet}
                  onRun={() => void runSnippet(snippet)}
                  onEdit={() => openDialog(snippet)}
                  onDelete={() => handleDelete(snippet)}
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

function SnippetCard({
  snippet,
  onRun,
  onEdit,
  onDelete,
}: {
  snippet: Snippet;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article
      className={cn(
        "group relative flex h-full flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.025]",
        "p-5 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]",
      )}
    >
      {/* Title + actions menu */}
      <header className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 flex-1 text-[15px] font-semibold text-foreground/90">
          {snippet.title}
        </h3>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Snippet actions"
              className={cn(
                "-m-1 rounded-md p-1 text-foreground/45 transition-opacity hover:bg-foreground/10 hover:text-foreground",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRun}>
              <Play className="h-4 w-4" /> Run
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" /> Edit
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

      {/* Prompt body — fenced look so it reads as code/template, not chrome. */}
      <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/60">
        {snippet.prompt}
      </p>

      {/* Spacer keeps the footer pinned to the bottom even when prompts vary in
          length, so the Run buttons line up across rows. */}
      <div className="flex-1" />

      {/* Footer: meta on the left, Run on the right */}
      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
        <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-foreground/45">
          {snippet.provider && snippet.model ? (
            <span
              className="inline-flex max-w-[16ch] items-center gap-1 truncate rounded-full bg-foreground/[0.06] px-2 py-0.5 text-foreground/65"
              title={`${snippet.provider} · ${snippet.model}`}
            >
              <Cpu className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{snippet.model}</span>
            </span>
          ) : (
            <span className="italic text-foreground/40">Default model</span>
          )}
          <span aria-hidden className="text-foreground/25">
            ·
          </span>
          <span className="truncate" title={new Date(snippet.updated_at).toLocaleString()}>
            {relativeTime(snippet.updated_at)}
          </span>
        </div>
        <Button
          size="sm"
          onClick={onRun}
          className="h-8 gap-1 rounded-lg px-3 text-xs"
        >
          <Play className="h-3 w-3 fill-current" />
          Run
        </Button>
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Shared empty state — reused by SpacesLibrary too via plain shape parity, but
// kept local for now to avoid a tiny shared file.
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
