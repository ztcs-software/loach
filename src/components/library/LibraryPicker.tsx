import { useEffect, useMemo, useState } from "react";
import { Check, Library, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatTokens } from "@/lib/contextUsage";
import { sourcesVerdict } from "@/lib/sources";
import { cn, formatBytes } from "@/lib/utils";
import { expandSources, useLibraryStore } from "@/stores/libraryStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useUIStore } from "@/stores/uiStore";
import type { LibraryItemMeta, RetrievalMode } from "@/types";
import {
  DatasetIcon,
  domainOf,
  ItemIcon,
  itemTokens,
  mixLabel,
  TAB_LABELS,
  tabOf,
  type LibraryTab,
} from "./libraryUi";

export interface LibrarySelection {
  itemIds: string[];
  datasetIds: string[];
}

/**
 * Multi-select dialog over the whole Library — the one way in from a chat's
 * "+" menu, a Space's Sources tab, and a dataset's "Add items". Shows what
 * the selection costs against the context window, so "will this fit?" is
 * answered before anything is attached.
 */
export function LibraryPicker({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  allowDatasets = true,
  linkedItemIds = [],
  linkedDatasetIds = [],
  numCtx,
  spaceId = null,
  mode = "auto",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  allowDatasets?: boolean;
  /** Already attached — shown ticked and locked. */
  linkedItemIds?: string[];
  linkedDatasetIds?: string[];
  /** Context window the selection will be measured against. */
  numCtx?: number;
  /** The Space whose sources the chat (or Space) already gets. They count
   *  toward the estimate — the badge used to ignore them, so a chat in a
   *  Space with big sources read "Fits in full" — and items arriving through
   *  them show as "In Space" instead of being offered a second time. */
  spaceId?: string | null;
  /** How the chat or Space it's added to uses its sources — the badge says
   *  what that mode will do with the selection. */
  mode?: RetrievalMode;
  onConfirm: (sel: LibrarySelection) => void | Promise<void>;
}) {
  const items = useLibraryStore((s) => s.items);
  const datasets = useLibraryStore((s) => s.datasets);
  const hydrated = useLibraryStore((s) => s.hydrated);
  const hydrate = useLibraryStore((s) => s.hydrate);
  const [tab, setTab] = useState<LibraryTab>("datasets");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const tabs: LibraryTab[] = allowDatasets ? ["datasets", "texts", "files", "links"] : ["texts", "files", "links"];
  const counts: Record<LibraryTab, number> = {
    datasets: datasets.length,
    texts: items.filter((i) => i.kind === "text").length,
    files: items.filter((i) => i.kind === "file").length,
    links: items.filter((i) => i.kind === "link").length,
  };

  useEffect(() => {
    if (!open) return;
    if (!hydrated) void hydrate();
    setQuery("");
    setPicked(new Set());
    // Land on the first section with something in it.
    setTab(tabs.find((t) => counts[t] > 0) ?? tabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const linkedItems = useMemo(() => new Set(linkedItemIds), [linkedItemIds]);
  const linkedDatasets = useMemo(() => new Set(linkedDatasetIds), [linkedDatasetIds]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const spaceLinks = useLibraryStore((s) => (spaceId ? s.sources[`space:${spaceId}`] : undefined));
  const spaceFiles = useSpaceStore((s) => (spaceId ? s.spaceFiles[spaceId] : undefined));
  const fromSpace = useMemo(() => {
    const links = spaceLinks ?? [];
    return {
      items: new Set(expandSources(links, datasets, items).map((i) => i.id)),
      datasets: new Set(links.filter((l) => l.enabled && l.dataset_id).map((l) => l.dataset_id!)),
      uploadTokens: (spaceFiles ?? [])
        .filter((f) => f.enabled !== false && f.kind === "text")
        .reduce((n, f) => n + Math.ceil(f.data.length / 4), 0),
    };
  }, [spaceLinks, spaceFiles, datasets, items]);
  /** Why a row can't be picked, or null when it can. */
  const lockOf = (linked: boolean, inSpace: boolean) => (linked ? "Added" : inSpace ? "In Space" : null);

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    if (tab === "datasets") {
      return datasets
        .filter((d) => !q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q))
        .map((d) => {
          const members = d.item_ids.map((id) => byId.get(id)).filter((i): i is LibraryItemMeta => !!i);
          return {
            key: `d:${d.id}`,
            icon: <DatasetIcon size="sm" />,
            title: d.name,
            sub: `${mixLabel(members)} · ~${formatTokens(members.reduce((n, i) => n + itemTokens(i), 0))} tokens`,
            locked: lockOf(linkedDatasets.has(d.id), fromSpace.datasets.has(d.id)),
          };
        });
    }
    return items
      .filter((i) => tabOf(i) === tab)
      .filter(
        (i) =>
          !q ||
          i.title.toLowerCase().includes(q) ||
          i.preview.toLowerCase().includes(q) ||
          (i.url ?? "").toLowerCase().includes(q),
      )
      .map((i) => ({
        key: `i:${i.id}`,
        icon: <ItemIcon item={i} size="sm" />,
        title: i.title,
        sub: [
          i.kind === "link" ? domainOf(i.url) : formatBytes(i.size),
          i.media === "text" ? `~${formatTokens(itemTokens(i))} tokens` : "image",
        ].join(" · "),
        locked: lockOf(linkedItems.has(i.id), fromSpace.items.has(i.id)),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, datasets, items, q, byId, linkedDatasets, linkedItems, fromSpace]);

  // What the selection would add, each item counted once even when it's
  // also inside a picked dataset — or already attached. `total` adds what's
  // attached already: together they decide full text or excerpts.
  const selection = useMemo(() => {
    const tokensOf = (ids: Set<string>) => {
      let n = 0;
      for (const id of ids) {
        const it = byId.get(id);
        if (it) n += itemTokens(it);
      }
      return n;
    };
    const attached = new Set<string>([...linkedItems, ...fromSpace.items]);
    for (const id of linkedDatasets) datasets.find((d) => d.id === id)?.item_ids.forEach((i) => attached.add(i));
    const itemIds: string[] = [];
    const datasetIds: string[] = [];
    const reached = new Set<string>();
    const add = (id: string) => {
      if (!attached.has(id)) reached.add(id);
    };
    for (const key of picked) {
      const id = key.slice(2);
      if (key.startsWith("d:")) {
        datasetIds.push(id);
        datasets.find((d) => d.id === id)?.item_ids.forEach(add);
      } else {
        itemIds.push(id);
        add(id);
      }
    }
    const tokens = tokensOf(reached);
    return {
      itemIds,
      datasetIds,
      tokens,
      total: tokens + tokensOf(attached) + fromSpace.uploadTokens,
      hasAttached: attached.size > 0 || fromSpace.uploadTokens > 0,
    };
  }, [picked, datasets, byId, linkedItems, linkedDatasets, fromSpace]);

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm({ itemIds: selection.itemIds, datasetIds: selection.datasetIds });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const libraryError = useLibraryStore((s) => s.error);
  // Empty only once it has loaded — not while it loads, nor when it failed.
  const empty = hydrated && !libraryError && items.length === 0 && datasets.length === 0;
  const unavailable = !hydrated || (!!libraryError && items.length === 0 && datasets.length === 0);
  const verdict = numCtx ? sourcesVerdict(mode, selection.total, numCtx) : null;
  const badge =
    verdict === "full"
      ? { label: "Fits in full", warn: false, title: "Small enough to give the model in full." }
      : verdict === "cut"
        ? {
            label: "Will be cut short",
            warn: true,
            title: "Full text is on, but this is too big — it will be cut short to fit the context window.",
          }
        : verdict === "excerpts"
          ? mode === "retrieval"
            ? {
                label: "Will be searched",
                warn: false,
                title: "Sources here are set to Excerpts — the most relevant parts are retrieved for each message.",
              }
            : {
                label: "Will be searched",
                warn: true,
                title: "Too big to give in full — the most relevant excerpts will be retrieved for each message.",
              }
          : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[84vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="px-6 pb-3 pt-6 pr-14">
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-[18px] w-[18px] text-foreground/60" />
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {empty ? (
          <div className="mx-6 mb-6 flex flex-col items-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.015] px-6 py-12 text-center">
            <p className="text-sm font-medium text-foreground/80">Your Library is empty</p>
            <p className="mt-1.5 max-w-sm text-[13px] text-foreground/55">
              Save texts, files and links there once, then attach them to any chat or Space.
            </p>
            <Button
              className="mt-4 rounded-lg"
              onClick={() => {
                onOpenChange(false);
                useSpaceStore.getState().setViewingSpace(null);
                useModelsStore.getState().setViewingModel(null);
                useUIStore.getState().setSidebarTab("library");
              }}
            >
              Open Library
            </Button>
          </div>
        ) : unavailable ? (
          <div className="mx-6 mb-6 flex flex-col items-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.015] px-6 py-12 text-center">
            {libraryError ? (
              <>
                <p className="text-sm font-medium text-foreground/80">Couldn't load your Library</p>
                <p className="mt-1.5 max-w-sm text-[13px] text-foreground/55 [overflow-wrap:anywhere]">
                  {libraryError}
                </p>
                <Button variant="outline" className="mt-4 rounded-lg" onClick={() => void hydrate()}>
                  Try again
                </Button>
              </>
            ) : (
              <p className="flex items-center gap-2 text-sm text-foreground/55">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading your Library…
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
              <div role="tablist" className="flex flex-wrap gap-1">
                {tabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors",
                      tab === t
                        ? "bg-foreground/[0.10] text-foreground"
                        : "text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground",
                    )}
                  >
                    {TAB_LABELS[t]}
                    <span className="ml-1.5 tabular-nums text-foreground/40">{counts[t]}</span>
                  </button>
                ))}
              </div>
              <div className="relative ml-auto w-full sm:w-56">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/40" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  className="h-8 rounded-full pl-8 text-[13px]"
                  autoFocus
                />
              </div>
            </div>

            <div className="mx-6 min-h-[240px] flex-1 overflow-y-auto rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
              {rows.length === 0 ? (
                <p className="px-4 py-12 text-center text-[13px] text-foreground/45">
                  {q ? "Nothing matches your search." : `No ${TAB_LABELS[tab].toLowerCase()} yet.`}
                </p>
              ) : (
                <ul className="divide-y divide-foreground/[0.06]">
                  {rows.map((r) => {
                    const checked = !!r.locked || picked.has(r.key);
                    return (
                      <li key={r.key}>
                        <button
                          type="button"
                          disabled={!!r.locked}
                          onClick={() => toggle(r.key)}
                          aria-pressed={checked}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                            r.locked ? "cursor-default opacity-60" : "hover:bg-foreground/[0.04]",
                            picked.has(r.key) && "bg-primary/[0.06]",
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border transition-colors",
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-foreground/25",
                            )}
                          >
                            {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                          </span>
                          {r.icon}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] text-foreground/90">{r.title}</span>
                            <span className="block truncate text-[11.5px] text-foreground/45">{r.sub}</span>
                          </span>
                          {r.locked && (
                            <span className="shrink-0 text-[11px] text-foreground/45">{r.locked}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
              <div className="min-w-0 text-xs text-foreground/55">
                {picked.size === 0 ? (
                  allowDatasets ? "Pick datasets, texts, files or links." : "Pick texts, files or links."
                ) : (
                  <>
                    <span className="font-medium text-foreground/75">{picked.size} selected</span>
                    <span> · ~{formatTokens(selection.tokens)} tokens</span>
                    {selection.hasAttached && (
                      <span> (~{formatTokens(selection.total)} with what's attached)</span>
                    )}
                    {badge && (
                      <span
                        className={cn(
                          "ml-2 rounded-full px-2 py-0.5",
                          badge.warn
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        )}
                        title={badge.title}
                      >
                        {badge.label}
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-lg">
                  Cancel
                </Button>
                <Button onClick={() => void confirm()} disabled={busy || picked.size === 0} className="rounded-lg">
                  {confirmLabel}
                </Button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
