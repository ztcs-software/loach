import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  Copy,
  Cpu,
  Download,
  HardDrive,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Sliders,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import type { AdminProgress } from "@/stores/modelsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn, formatBytes } from "@/lib/utils";
import type { ModelInfo, ProviderId } from "@/types";

/**
 * Full-canvas browse-and-act surface for installed models. Mirrors
 * SpacesLibrary / SnippetsLibrary in shape so all three "library" tabs feel
 * like the same place in different outfits — same header, same search bar,
 * same tile grid. Replaces the dense in-sidebar ModelsPanel.
 *
 * Reached via the "Models" quick action in the sidebar — App.tsx routes to
 * this component when `sidebarTab === "models"` and no specific model is
 * being edited (which would route to ModelsView instead).
 */
export function ModelsLibrary() {
  const { confirm, prompt } = useConfirm();
  const models = useModelsStore((s) => s.models);
  const loading = useModelsStore((s) => s.loading);
  const error = useModelsStore((s) => s.error);
  const hydrate = useModelsStore((s) => s.hydrate);
  const refresh = useModelsStore((s) => s.refresh);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);
  const deleteModel = useModelsStore((s) => s.deleteModel);
  const copyModel = useModelsStore((s) => s.copyModel);
  const pullModel = useModelsStore((s) => s.pullModel);
  const runs = useModelsStore((s) => s.runs);
  const dismissRun = useModelsStore((s) => s.dismissRun);
  const cancelRun = useModelsStore((s) => s.cancelRun);
  const newSession = useChatStore((s) => s.newSession);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);

  const [pullOpen, setPullOpen] = useState(false);
  const [pullTag, setPullTag] = useState("");

  // Lazy hydrate on first mount.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const ollamaModels = useMemo(
    () => models.filter((m) => m.provider === "ollama"),
    [models],
  );
  const openaiModels = useMemo(
    () => models.filter((m) => m.provider === "openai"),
    [models],
  );

  const activeRuns = Object.entries(runs);

  const handleStartPull = async () => {
    const tag = pullTag.trim();
    if (!tag) return;
    setPullOpen(false);
    setPullTag("");
    await pullModel(tag);
  };

  // Land on the chats canvas first so the new session's composer renders,
  // then open a chat pinned to the chosen model. We clear any stale
  // viewing-space state so we don't drop into a SpaceView with the wrong
  // model — Models tiles aren't space-aware.
  const newChatWithModel = (m: ModelInfo) => {
    setViewingSpace(null);
    setSidebarTab("chats");
    void newSession({
      spaceId: null,
      provider: m.provider as ProviderId,
      model: m.id,
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-8 py-8">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight text-foreground">
                <Cpu className="h-6 w-6 text-foreground/60" />
                Models
              </h1>
              <p className="mt-2 max-w-xl text-sm text-foreground/55">
                Manage local Ollama models and inspect the OpenAI catalog.
                Click a tile to customize parameters and the Modelfile.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void refresh()}
                disabled={loading}
                className="gap-1.5 rounded-xl"
                title="Refresh model list"
              >
                <RefreshCw
                  className={cn("h-4 w-4", loading && "animate-spin")}
                />
                Refresh
              </Button>
              <Button
                onClick={() => setPullOpen((v) => !v)}
                className="gap-1.5 rounded-xl"
              >
                <Plus className="h-4 w-4" />
                Pull model
              </Button>
            </div>
          </header>

          {/* Pull form — shows below the header so the action flow stays
              visible without a modal. Enter to confirm, Esc to cancel. */}
          {pullOpen && (
            <div className="mb-4 rounded-2xl border border-foreground/10 bg-foreground/[0.025] p-4">
              <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/45">
                Model tag
              </label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  autoFocus
                  value={pullTag}
                  onChange={(e) => setPullTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleStartPull();
                    if (e.key === "Escape") {
                      setPullOpen(false);
                      setPullTag("");
                    }
                  }}
                  placeholder="llama3.1:8b"
                  className="h-9 rounded-lg text-sm"
                />
                <Button
                  className="h-9 rounded-lg px-4"
                  disabled={!pullTag.trim()}
                  onClick={() => void handleStartPull()}
                >
                  Pull
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 rounded-lg px-3"
                  onClick={() => {
                    setPullOpen(false);
                    setPullTag("");
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-foreground/45">
                Browse tags at{" "}
                <span className="font-mono">ollama.com/library</span>
              </p>
            </div>
          )}

          {/* Active runs stacked, one chip each. */}
          {activeRuns.length > 0 && (
            <div className="mb-4 space-y-2">
              {activeRuns.map(([id, run]) => (
                <RunChip
                  key={id}
                  run={run}
                  onCancel={() => void cancelRun(id)}
                  onDismiss={() => dismissRun(id)}
                />
              ))}
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] text-destructive">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Ollama section */}
          <SectionLabel label="Ollama" count={ollamaModels.length} />
          {ollamaModels.length === 0 && !loading ? (
            <div className="mx-auto mt-4 flex max-w-md flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.015] px-8 py-10 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.05]">
                <Cpu className="h-6 w-6 text-foreground/45" />
              </div>
              <h2 className="text-sm font-semibold text-foreground/85">
                No Ollama models installed
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-foreground/55">
                Click <span className="font-medium">Pull model</span> above to
                download a tag from the Ollama library.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {ollamaModels.map((m) => (
                <ModelTile
                  key={`ollama-${m.id}`}
                  model={m}
                  onCustomize={() => setViewingModel(m.id)}
                  onNewChat={() => newChatWithModel(m)}
                  onDuplicate={async () => {
                    const dest = await prompt({
                      title: `Duplicate “${m.id}”`,
                      body: "Pick a name for the duplicated model. The new tag is created with the same weights.",
                      defaultValue: `${m.id.split(":")[0]}-copy`,
                      confirmLabel: "Duplicate",
                    });
                    if (dest && dest.trim()) {
                      void copyModel(m.id, dest.trim());
                    }
                  }}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: `Delete “${m.id}”?`,
                      body: "This removes the model files from disk and cannot be undone.",
                      confirmLabel: "Delete model",
                      destructive: true,
                    });
                    if (ok) void deleteModel(m.id);
                  }}
                />
              ))}
            </div>
          )}

          {/* OpenAI section — read-only catalog */}
          {openaiModels.length > 0 && (
            <>
              <div className="mt-8">
                <SectionLabel
                  label="OpenAI"
                  count={openaiModels.length}
                  hint="Read-only catalog from your OpenAI-compatible endpoint"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {openaiModels.map((m) => (
                  <div
                    key={`openai-${m.id}`}
                    className="flex items-center gap-2 rounded-xl border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2 text-[13px] text-foreground/75"
                    title="OpenAI-compatible models are read-only"
                  >
                    <Cpu className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header — provider grouping label with a count.
// ---------------------------------------------------------------------------

function SectionLabel({
  label,
  count,
  hint,
}: {
  label: string;
  count: number;
  hint?: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-sm font-semibold tracking-tight text-foreground/85">
        {label}
      </h2>
      <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-foreground/60">
        {count}
      </span>
      {hint && (
        <span className="hidden truncate text-[11px] italic text-foreground/40 sm:inline">
          {hint}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

function ModelTile({
  model,
  onCustomize,
  onNewChat,
  onDuplicate,
  onDelete,
}: {
  model: ModelInfo;
  /** Tile body click + kebab "Customize" both use this — opens the model
   *  editor view. */
  onCustomize: () => void;
  /** Footer button — starts a new chat pinned to this model. */
  onNewChat: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sizeLabel = model.size ? formatBytes(model.size) : null;
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Customize model: ${model.id}`}
      onClick={onCustomize}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCustomize();
        }
      }}
      className={cn(
        "group relative flex h-full cursor-pointer flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.025]",
        "p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
          <h3 className="line-clamp-1 text-[14px] font-semibold text-foreground/90">
            {model.id}
          </h3>
        </div>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Model actions"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "-m-1 rounded-md p-1 text-foreground/45 transition-opacity hover:bg-foreground/10 hover:text-foreground",
                menuOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onCustomize}>
              <Sliders className="h-4 w-4" /> Customize
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy className="h-4 w-4" /> Duplicate…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {model.family && (
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-foreground/65">
            {model.family}
          </span>
        )}
        {sizeLabel && (
          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-foreground/65">
            <HardDrive className="h-2.5 w-2.5" />
            {sizeLabel}
          </span>
        )}
      </div>

      <div className="flex-1" />

      <footer className="mt-4 flex items-center justify-end gap-2 border-t border-foreground/[0.06] pt-3">
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            // Tile body opens Customize; the footer is a separate verb
            // (New chat with this model) and shouldn't double-trigger.
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
// Run chip — same logic as the old ModelsPanel version, restyled to live
// inside the wider canvas with more horizontal room.
// ---------------------------------------------------------------------------

function RunChip({
  run,
  onCancel,
  onDismiss,
}: {
  run: AdminProgress;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pct =
    run.total > 0
      ? Math.min(100, Math.round((run.completed / run.total) * 100))
      : null;
  const verb = run.kind === "pull" ? "Pulling" : "Creating";
  const terminal = run.finished;
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2.5 text-[12px]",
        terminal === "error"
          ? "border-destructive/30 bg-destructive/[0.06] text-destructive"
          : "border-foreground/10 bg-foreground/[0.04] text-foreground/75",
      )}
    >
      <div className="flex items-center gap-2">
        {terminal === null && (
          <Download className="h-3.5 w-3.5 shrink-0 animate-pulse" />
        )}
        {terminal === "ok" && (
          <Download className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}
        {terminal === "error" && (
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {verb} {run.target}
        </span>
        <button
          type="button"
          onClick={terminal === null ? onCancel : onDismiss}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-foreground/45 transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label={terminal === null ? "Cancel" : "Dismiss"}
        >
          ✕
        </button>
      </div>
      <div className="mt-1 truncate text-[11px] text-foreground/55">
        {run.error ?? run.status}
      </div>
      {terminal === null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              "h-full bg-primary transition-[width]",
              pct === null && "w-1/3 animate-pulse",
            )}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}
    </div>
  );
}
