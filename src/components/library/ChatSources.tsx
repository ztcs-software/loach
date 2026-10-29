import { useEffect, useMemo, useRef } from "react";
import { Check, ChevronDown, Database, FileText, Globe, Image, Layers, NotebookPen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChipRemove,
  composerChipClass,
  composerChipIconClass,
} from "@/components/ComposerChip";
import { formatTokens } from "@/lib/contextUsage";
import { setSessionRetrievalMode } from "@/lib/tauri";
import { chatRetrievalMode, estimateChatSources, spaceSourceCount } from "@/lib/sources";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";
import {
  DEFAULT_PARAMS,
  OPENAI_COMPAT_NUM_CTX,
  type LibraryDataset,
  type LibraryItemMeta,
  type RetrievalMode,
  type SpaceFile,
} from "@/types";
import { DatasetIcon, ItemIcon, itemTokens, mixLabel } from "./libraryUi";

const EMPTY_FILES: SpaceFile[] = [];

export const MODE_LABELS: Record<RetrievalMode, { label: string; hint: string }> = {
  auto: {
    label: "Auto",
    hint: "Full text while it fits half the context window, the most relevant excerpts once it doesn't.",
  },
  full: {
    label: "Full text",
    hint: "Always give the model the whole text. Cut short, with a note, if it can't fit.",
  },
  retrieval: {
    label: "Excerpts",
    hint: "Always search the sources and give the model only the parts relevant to each message.",
  },
};

interface ChipRef {
  key: string;
  kind: "item" | "dataset";
  id: string;
  /** Link row id, absent for sources picked before the chat exists. */
  sourceId: string | null;
  title: string;
  item?: LibraryItemMeta;
  dataset?: LibraryDataset;
}

/** Everything a chat draws on besides its transcript, for the composer. */
export function useChatSources(sessionId: string | null, spaceId: string | null) {
  const items = useLibraryStore((s) => s.items);
  const datasets = useLibraryStore((s) => s.datasets);
  const sessionSources = useLibraryStore((s) => (sessionId ? s.sources[`session:${sessionId}`] : undefined));
  const spaceSources = useLibraryStore((s) => (spaceId ? s.sources[`space:${spaceId}`] : undefined));
  const pending = useLibraryStore((s) => s.pending);
  const ensureSources = useLibraryStore((s) => s.ensureSources);
  const spaceFiles = useSpaceStore((s) => (spaceId ? s.spaceFiles[spaceId] : undefined));
  const loadSpaceFiles = useSpaceStore((s) => s.loadSpaceFiles);

  useEffect(() => {
    if (sessionId) void ensureSources("session", sessionId).catch(() => undefined);
    if (spaceId) void ensureSources("space", spaceId).catch(() => undefined);
    if (spaceId && !useSpaceStore.getState().spaceFiles[spaceId]) {
      void loadSpaceFiles(spaceId).catch(() => undefined);
    }
  }, [sessionId, spaceId, ensureSources, loadSpaceFiles]);

  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const dsById = new Map(datasets.map((d) => [d.id, d]));
    const chips: ChipRef[] = [];
    const push = (kind: "item" | "dataset", id: string, sourceId: string | null) => {
      if (kind === "item") {
        const item = byId.get(id);
        if (item) chips.push({ key: `i:${id}`, kind, id, sourceId, title: item.title, item });
      } else {
        const dataset = dsById.get(id);
        if (dataset) chips.push({ key: `d:${id}`, kind, id, sourceId, title: dataset.name, dataset });
      }
    };
    if (sessionId) {
      for (const src of sessionSources ?? []) {
        if (src.item_id) push("item", src.item_id, src.id);
        else if (src.dataset_id) push("dataset", src.dataset_id, src.id);
      }
    } else if (pending.spaceId === spaceId) {
      // Picks parked for a chat in another Space aren't this composer's.
      pending.datasetIds.forEach((id) => push("dataset", id, null));
      pending.itemIds.forEach((id) => push("item", id, null));
    }
    const fromSpace = spaceSourceCount(spaceFiles ?? EMPTY_FILES, spaceSources ?? [], datasets, items);
    return { chips, spaceCount: fromSpace };
  }, [items, datasets, sessionSources, spaceSources, spaceFiles, pending, sessionId]);
}

/**
 * The chat's sources as composer chips — removable Library items and
 * datasets, a summary chip for what the Space brings, and the mode switch.
 * Rendered inside the composer's chip row; renders nothing when the chat has
 * no sources.
 */
export function ChatSourceChips({
  sessionId,
  spaceId,
}: {
  sessionId: string | null;
  spaceId: string | null;
}) {
  const { chips, spaceCount } = useChatSources(sessionId, spaceId);
  const removeSource = useLibraryStore((s) => s.removeSource);
  const removePending = useLibraryStore((s) => s.removePending);
  const openPreview = useLibraryStore((s) => s.openPreview);
  const setViewingDataset = useLibraryStore((s) => s.setViewingDataset);
  if (chips.length === 0 && spaceCount === 0) return null;

  const openDataset = (id: string) => {
    setViewingDataset(id);
    useSpaceStore.getState().setViewingSpace(null);
    useModelsStore.getState().setViewingModel(null);
    useUIStore.getState().setSidebarTab("library");
  };

  return (
    <>
      {chips.map((c) => {
        const members = c.dataset ? c.dataset.item_ids.length : 0;
        return (
          <div
            key={c.key}
            className={cn(composerChipClass("config"), "max-w-[240px]")}
            title={
              c.dataset
                ? `Dataset · ${members} item${members === 1 ? "" : "s"} — used on every message in this chat`
                : `Library ${c.item?.kind ?? "item"} — used on every message in this chat`
            }
          >
            <button
              type="button"
              onClick={() => (c.kind === "item" ? openPreview(c.id) : openDataset(c.id))}
              className="inline-flex min-w-0 items-center gap-1.5"
            >
              <ChipIcon chip={c} />
              <span className="truncate">{c.title}</span>
            </button>
            <ChipRemove
              label={`Remove ${c.title} from this chat`}
              onClick={() =>
                c.sourceId && sessionId
                  ? void removeSource("session", sessionId, c.sourceId)
                  : removePending(c.id)
              }
            />
          </div>
        );
      })}
      {spaceCount > 0 && spaceId && (
        <button
          type="button"
          // Straight to the Space's Sources tab — what the chip is about, and
          // on the Space's own page the only thing a click could mean.
          onClick={() => {
            useModelsStore.getState().setViewingModel(null);
            useUIStore.getState().setSidebarTab("spaces");
            useSpaceStore.getState().setViewingSpace(spaceId, "files");
          }}
          className={cn(composerChipClass("config"), "hover:bg-primary/15")}
          title="Sources this chat gets from its Space — manage them in the Space's Sources tab"
        >
          <Layers className={composerChipIconClass("config")} />
          <span>
            {spaceCount} Space source{spaceCount === 1 ? "" : "s"}
          </span>
        </button>
      )}
      {sessionId && <ModeChip sessionId={sessionId} spaceId={spaceId} />}
    </>
  );
}

function ChipIcon({ chip }: { chip: ChipRef }) {
  const cls = composerChipIconClass("config");
  if (chip.kind === "dataset") return <Database className={cls} />;
  if (chip.item?.kind === "text") return <NotebookPen className={cls} />;
  if (chip.item?.kind === "link") return <Globe className={cls} />;
  if (chip.item?.media === "image") return <Image className={cls} />;
  return <FileText className={cls} />;
}

/** The context window a chat's sends are sized against, layered the way
 *  the send layers it: its own `num_ctx` override, else its Space's, else
 *  the model's default (a Modelfile's `num_ctx`), else the app default. */
export function chatNumCtx(
  sessionParams: string | null | undefined,
  spaceParams: string | null | undefined,
  modelNumCtx?: number | null,
): number {
  let n = modelNumCtx && modelNumCtx > 0 ? modelNumCtx : (DEFAULT_PARAMS.num_ctx ?? 8192);
  for (const json of [spaceParams, sessionParams]) {
    if (!json) continue;
    try {
      const p = JSON.parse(json) as { num_ctx?: number };
      if (typeof p.num_ctx === "number" && p.num_ctx > 0) n = p.num_ctx;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** How this chat's sources reach the model, with the effective result. */
function ModeChip({ sessionId, spaceId }: { sessionId: string; spaceId: string | null }) {
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId));
  const space = useSpaceStore((s) => (spaceId ? s.spaces.find((x) => x.id === spaceId) : undefined));
  const spaceFiles = useSpaceStore((s) => (spaceId ? s.spaceFiles[spaceId] : undefined));
  // Re-estimate when the Library or the links change.
  useLibraryStore((s) => s.items);
  useLibraryStore((s) => s.sources);
  const modelNumCtx = useModelsStore((s) =>
    session?.provider === "ollama" && session.model
      ? s.modelDefaults[session.model]?.num_ctx
      : session
        ? OPENAI_COMPAT_NUM_CTX
        : undefined,
  );
  const numCtx = chatNumCtx(session?.params_json, space?.default_params_json, modelNumCtx);
  if (!session) return null;

  const pref = chatRetrievalMode(session, space?.retrieval_mode);
  const est = estimateChatSources({
    session,
    spaceFiles: spaceFiles ?? EMPTY_FILES,
    spaceMode: space?.retrieval_mode,
    numCtx,
  });
  const effective = est.mode === "retrieval" ? "excerpts" : "full text";
  // The ticked row. Outside a Space there's no "inherit" row, so a chat
  // that never picked a mode shows the Auto it actually runs in.
  const selected = session.retrieval_mode ?? (space ? null : "auto");
  const setMode = async (mode: RetrievalMode | null) => {
    try {
      await setSessionRetrievalMode(sessionId, mode);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't change how sources are used",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    useChatStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, retrieval_mode: mode } : x)),
    }));
  };
  const options: RetrievalMode[] = ["auto", "full", "retrieval"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(composerChipClass("attachment"), "gap-1 hover:bg-foreground/10")}
          title={`${MODE_LABELS[pref].hint} Now: ${effective}, ~${formatTokens(est.tokens)} tokens.`}
        >
          <span className="text-foreground/60">Sources:</span>
          <span>{MODE_LABELS[pref].label}</span>
          {pref === "auto" && est.mode && <span className="text-foreground/50">· {effective}</span>}
          <ChevronDown className="h-3 w-3 text-foreground/50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-[300px]">
        <DropdownMenuLabel className="text-xs text-foreground/50">
          How sources reach the model
        </DropdownMenuLabel>
        {options.map((m) => (
          <DropdownMenuItem key={m} onSelect={() => void setMode(m)} className="items-start">
            <Check
              className={cn("mt-0.5 h-4 w-4 shrink-0", selected === m ? "opacity-100" : "opacity-0")}
            />
            <div className="min-w-0">
              <div>{MODE_LABELS[m].label}</div>
              <p className="text-[11px] leading-snug text-foreground/50">{MODE_LABELS[m].hint}</p>
            </div>
          </DropdownMenuItem>
        ))}
        {space && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void setMode(null)} className="items-start">
              <Check
                className={cn("mt-0.5 h-4 w-4 shrink-0", selected == null ? "opacity-100" : "opacity-0")}
              />
              <div className="min-w-0">
                <div>Use the Space's setting</div>
                <p className="text-[11px] leading-snug text-foreground/50">
                  Currently {MODE_LABELS[space.retrieval_mode].label.toLowerCase()}.
                </p>
              </div>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// `#` mentions
// ---------------------------------------------------------------------------

export interface MentionEntry {
  kind: "item" | "dataset";
  id: string;
  title: string;
  sub: string;
  item?: LibraryItemMeta;
}

/** The `#query` token right before the caret, if the caret sits in one. A
 *  `#` only counts at the start or after whitespace, so `C#` and URLs with
 *  fragments don't open the list. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)#([^\s#]{0,40})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Library entries matching a mention query: prefix matches first, then
 *  substring matches, each newest-first. At most `limit`. */
export function matchMentions(
  query: string,
  items: LibraryItemMeta[],
  datasets: LibraryDataset[],
  limit = 8,
): MentionEntry[] {
  const q = query.toLowerCase();
  const byId = new Map(items.map((i) => [i.id, i]));
  const all: (MentionEntry & { updated: number })[] = [
    ...datasets.map((d) => {
      const members = d.item_ids.map((id) => byId.get(id)).filter((i): i is LibraryItemMeta => !!i);
      return {
        kind: "dataset" as const,
        id: d.id,
        title: d.name,
        sub: `Dataset · ${mixLabel(members)}`,
        updated: d.updated_at,
      };
    }),
    ...items.map((i) => ({
      kind: "item" as const,
      id: i.id,
      title: i.title,
      sub: `${i.kind === "text" ? "Text" : i.kind === "link" ? "Link" : "File"}${i.media === "text" ? ` · ~${formatTokens(itemTokens(i))} tokens` : ""}`,
      item: i,
      updated: i.updated_at,
    })),
  ];
  const rank = (e: { title: string }) => {
    const t = e.title.toLowerCase();
    if (!q) return 1;
    if (t.startsWith(q)) return 0;
    if (t.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 1;
    if (t.includes(q)) return 2;
    return -1;
  };
  return all
    .map((e) => ({ e, r: rank(e) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || b.e.updated - a.e.updated)
    .slice(0, limit)
    .map(({ e }) => ({ kind: e.kind, id: e.id, title: e.title, sub: e.sub, item: e.item }));
}

export function MentionPalette({
  entries,
  highlightIndex,
  onHighlightChange,
  onSelect,
}: {
  entries: MentionEntry[];
  highlightIndex: number;
  onHighlightChange: (i: number) => void;
  onSelect: (e: MentionEntry) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlightIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2" onMouseDown={(e) => e.preventDefault()}>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Attach from your Library"
        className="mx-auto max-h-[300px] w-full max-w-3xl overflow-y-auto rounded-2xl border border-foreground/10 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-xl"
      >
        <div className="flex items-baseline justify-between px-3 pb-1 pt-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/40">
            Attach from Library
          </span>
          <span className="text-[10.5px] text-foreground/40">Tab to attach · Enter sends</span>
        </div>
        {entries.map((e, i) => (
          <button
            key={`${e.kind}:${e.id}`}
            type="button"
            role="option"
            aria-selected={i === highlightIndex}
            data-mention-index={i}
            onMouseEnter={() => onHighlightChange(i)}
            onClick={() => onSelect(e)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
              i === highlightIndex ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
            )}
          >
            {e.kind === "dataset" ? <DatasetIcon size="sm" /> : e.item && <ItemIcon item={e.item} size="sm" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-foreground/90">{e.title}</span>
              <span className="block truncate text-[11.5px] text-foreground/45">{e.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
