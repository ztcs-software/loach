import { useEffect } from "react";
import {
  Cpu,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSnippetStore } from "@/stores/snippetStore";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { Snippet } from "@/types";
import { cn } from "@/lib/utils";

export function SnippetsView() {
  const snippets = useSnippetStore((s) => s.snippets);
  const hydrate = useSnippetStore((s) => s.hydrate);
  const openDialog = useSnippetStore((s) => s.openDialog);
  const remove = useSnippetStore((s) => s.remove);

  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingSnippets = useUIStore((s) => s.setViewingSnippets);
  const setViewingSpacesList = useUIStore((s) => s.setViewingSpacesList);
  const primeComposer = useUIStore((s) => s.primeComposer);

  // Snippets hydrate on mount — we deliberately skip eager hydration on app
  // boot because most users won't open this view.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const runSnippet = async (snippet: Snippet) => {
    // Leave any space / snippets view and create a fresh, space-less chat —
    // matches the behaviour of the sidebar's "+ New chat" so running a snippet
    // never silently inherits unrelated context.
    setViewingSnippets(false);
    setViewingSpacesList(false);
    setViewingSpace(null);
    await newSession({
      spaceId: null,
      provider: snippet.provider ?? undefined,
      model: snippet.model ?? undefined,
    });
    primeComposer(snippet.prompt, []);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Snippets
            </h1>
            <p className="mt-1.5 text-sm text-foreground/55">
              Reusable prompts you can launch into a fresh chat. Pin a default
              model to any snippet so it picks the right provider automatically.
            </p>
          </div>
          <Button
            onClick={() => openDialog("new")}
            className="shrink-0 gap-1.5 rounded-xl"
          >
            <Plus className="h-4 w-4" />
            New snippet
          </Button>
        </div>

        {snippets.length === 0 ? (
          <EmptyState onCreate={() => openDialog("new")} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {snippets.map((s) => (
              <SnippetTile
                key={s.id}
                snippet={s}
                onRun={() => void runSnippet(s)}
                onEdit={() => openDialog(s)}
                onDelete={() => void remove(s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-8 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.06] text-foreground/60">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-lg font-medium">No snippets yet</h2>
      <p className="mt-1.5 max-w-md text-sm text-foreground/55">
        Save prompts you reuse — code-review checklists, translation templates,
        summary formats — and kick them off into a new chat with one click.
      </p>
      <Button onClick={onCreate} className="mt-5 gap-1.5 rounded-xl">
        <Plus className="h-4 w-4" />
        Create your first snippet
      </Button>
    </div>
  );
}

function SnippetTile({
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
  const previewText = snippet.prompt.trim() || "(no prompt text)";

  return (
    <div
      className={cn(
        "group flex min-h-[180px] flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.04] p-4 transition-colors",
        "hover:border-foreground/20 hover:bg-foreground/[0.06]",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">
          {snippet.title}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Snippet actions"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
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

      <p className="mb-3 line-clamp-4 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/65">
        {previewText}
      </p>

      {snippet.provider && snippet.model && (
        <div className="mb-3">
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-foreground/10 bg-foreground/[0.03] px-2 py-0.5 text-[11px] text-foreground/65">
            <Cpu className="h-3 w-3 shrink-0 text-foreground/55" />
            <span className="truncate">
              {snippet.model}
              <span className="text-foreground/45"> · {snippet.provider}</span>
            </span>
          </span>
        </div>
      )}

      <div className="mt-auto flex justify-end">
        <Button
          size="sm"
          onClick={onRun}
          className="gap-1.5 rounded-xl bg-gradient-to-br from-orange-500 to-rose-600 text-white shadow-[0_4px_16px_-4px_rgba(255,90,40,0.5)] hover:from-orange-400 hover:to-rose-500"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
          Run
        </Button>
      </div>
    </div>
  );
}
