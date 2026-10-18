import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  FileText,
  Image as ImageIcon,
  Library,
  MoreHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatTokens } from "@/lib/contextUsage";
import { SPACE_BYTES_CAP } from "@/lib/files";
import { FULL_TEXT_SHARE, resolveMode, retrievalBudgetTokens } from "@/lib/sources";
import { cn, formatBytes } from "@/lib/utils";
import { useLibraryStore } from "@/stores/libraryStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { LibraryItemMeta, RetrievalMode, Space, SpaceFile } from "@/types";
import { chatNumCtx, MODE_LABELS } from "./ChatSources";
import { LibraryPicker } from "./LibraryPicker";
import { DatasetIcon, ItemIcon, itemTokens, mixLabel, typeLabel } from "./libraryUi";

/**
 * The Sources tab of a Space: its own uploads plus Library items and
 * datasets linked to it, each switchable on and off, and how all of them
 * reach the model. Uploads live in the Space; Library sources are links —
 * edited in the Library, seen here on the next message.
 */
export function SpaceSourcesTab({
  space,
  files,
  onUpload,
  onRemoveFile,
}: {
  space: Space;
  files: SpaceFile[];
  onUpload: (files: FileList) => Promise<void>;
  onRemoveFile: (fileId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const items = useLibraryStore((s) => s.items);
  const datasets = useLibraryStore((s) => s.datasets);
  const sources = useLibraryStore((s) => s.sources[`space:${space.id}`]);
  const ensureSources = useLibraryStore((s) => s.ensureSources);
  const addSources = useLibraryStore((s) => s.addSources);
  const removeSource = useLibraryStore((s) => s.removeSource);
  const setSourceEnabled = useLibraryStore((s) => s.setSourceEnabled);
  const openPreview = useLibraryStore((s) => s.openPreview);
  const setFocusDataset = useLibraryStore((s) => s.setFocusDataset);
  const saveToLibrary = useLibraryStore((s) => s.saveToLibrary);
  const setFileEnabled = useSpaceStore((s) => s.setFileEnabled);
  const setRetrievalMode = useSpaceStore((s) => s.setRetrievalMode);

  useEffect(() => {
    void ensureSources("space", space.id).catch(() => undefined);
  }, [space.id, ensureSources]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const dsById = useMemo(() => new Map(datasets.map((d) => [d.id, d])), [datasets]);
  const links = sources ?? [];

  // What the model gets: enabled uploads + enabled links, each item once.
  const { tokens, count } = useMemo(() => {
    let chars = 0;
    let n = 0;
    for (const f of files) {
      if (!f.enabled || f.kind !== "text") continue;
      chars += f.data.length;
      n += 1;
    }
    const seen = new Set<string>();
    const add = (id: string) => {
      const it = byId.get(id);
      if (!it || seen.has(id)) return;
      seen.add(id);
      if (it.media === "text") {
        chars += it.chars;
        n += 1;
      }
    };
    for (const l of links) {
      if (!l.enabled) continue;
      if (l.item_id) add(l.item_id);
      else if (l.dataset_id) dsById.get(l.dataset_id)?.item_ids.forEach(add);
    }
    return { tokens: Math.ceil(chars / 4), count: n };
  }, [files, links, byId, dsById]);

  const numCtx = chatNumCtx(null, space.default_params_json);
  const effective = resolveMode(space.retrieval_mode, tokens, numCtx);
  const threshold = Math.round(numCtx * FULL_TEXT_SHARE);
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const atCap = totalBytes >= SPACE_BYTES_CAP;

  const handlePick = async (list: FileList) => {
    setError(null);
    setBusy(true);
    try {
      await onUpload(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDataset = (id: string) => {
    setFocusDataset(id);
    useSpaceStore.getState().setViewingSpace(null);
    useModelsStore.getState().setViewingModel(null);
    useUIStore.getState().setSidebarTab("library");
  };

  const empty = files.length === 0 && links.length === 0;

  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground/55">
        Reference material for every chat in this Space. Uploads belong to the Space; Library
        sources stay linked, so edits in the Library reach these chats too. Switch a source off to
        keep it here without using it.
      </p>

      {/* How sources reach the model */}
      <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground/85">How sources reach the model</div>
            <p className="mt-0.5 text-xs text-foreground/50">{MODE_LABELS[space.retrieval_mode].hint}</p>
          </div>
          <div
            role="radiogroup"
            aria-label="Source mode"
            className="inline-flex rounded-xl border border-foreground/10 bg-foreground/[0.04] p-0.5"
          >
            {(["auto", "full", "retrieval"] as RetrievalMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={space.retrieval_mode === m}
                onClick={() => void setRetrievalMode(space.id, m)}
                className={cn(
                  "rounded-[10px] px-3 py-1 text-xs font-medium transition-colors",
                  space.retrieval_mode === m
                    ? "bg-foreground/[0.10] text-foreground"
                    : "text-foreground/55 hover:text-foreground",
                )}
              >
                {MODE_LABELS[m].label}
              </button>
            ))}
          </div>
        </div>
        {count > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-foreground/50">
              <span>
                ~{formatTokens(tokens)} tokens in {count} source{count === 1 ? "" : "s"} ·{" "}
                <span className="font-medium text-foreground/70">
                  {effective === "full"
                    ? "the model reads them in full"
                    : `the model gets ~${formatTokens(retrievalBudgetTokens(numCtx))} tokens of the most relevant excerpts per message`}
                </span>
              </span>
              <span className="tabular-nums">{formatTokens(numCtx)} window</span>
            </div>
            <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  tokens <= threshold ? "bg-primary/70" : "bg-amber-400/80",
                )}
                style={{ width: `${Math.min(100, Math.max(2, (tokens / numCtx) * 100))}%` }}
              />
              <div
                aria-hidden
                className="absolute inset-y-0 w-px bg-foreground/40"
                style={{ left: `${FULL_TEXT_SHARE * 100}%` }}
                title="Auto switches to excerpts past this point"
              />
            </div>
          </div>
        )}
      </div>

      {/* Add row */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm text-foreground/55">
          <Upload className="h-4 w-4" />
          <span>
            {atCap
              ? "Reached the 200 MB upload limit"
              : `${formatBytes(totalBytes)} of 200 MB uploaded · ${links.length} from Library`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPickerOpen(true)}
            className="gap-1.5 rounded-lg"
          >
            <Library className="h-3.5 w-3.5" />
            From Library
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={atCap || busy}
            className="gap-1.5 rounded-lg"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload
          </Button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handlePick(e.target.files);
          e.target.value = "";
        }}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!empty && (
        <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.02]">
          {links.map((l) => {
            const ds = l.dataset_id ? dsById.get(l.dataset_id) : undefined;
            const it = l.item_id ? byId.get(l.item_id) : undefined;
            if (!ds && !it) return null;
            const members = ds
              ? ds.item_ids.map((id) => byId.get(id)).filter((i): i is LibraryItemMeta => !!i)
              : [];
            const t = ds ? members.reduce((n, i) => n + itemTokens(i), 0) : itemTokens(it!);
            return (
              <SourceRow
                key={l.id}
                enabled={l.enabled}
                onToggle={(on) => void setSourceEnabled("space", space.id, l.id, on)}
                icon={ds ? <DatasetIcon size="sm" /> : <ItemIcon item={it!} size="sm" />}
                title={ds ? ds.name : it!.title}
                sub={ds ? `Dataset · ${mixLabel(members)}` : `Library · ${typeLabel(it!)}`}
                tokens={t}
                onOpen={() => (ds ? openDataset(ds.id) : openPreview(it!.id))}
                actions={
                  <button
                    type="button"
                    onClick={() => void removeSource("space", space.id, l.id)}
                    aria-label={`Unlink ${ds ? ds.name : it!.title}`}
                    title="Remove from this Space (stays in your Library)"
                    className="rounded-md p-1 text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                }
              />
            );
          })}
          {files.map((f) => (
            <SourceRow
              key={f.id}
              enabled={f.enabled}
              onToggle={(on) => void setFileEnabled(f.id, space.id, on)}
              icon={
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/55">
                  {f.kind === "image" ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                </span>
              }
              title={f.name}
              sub={`Uploaded · ${formatBytes(f.size)}`}
              tokens={f.kind === "text" ? Math.ceil(f.data.length / 4) : null}
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${f.name}`}
                      className="rounded-md p-1 text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        void saveToLibrary({
                          kind: "file",
                          title: f.name,
                          mime: f.mime,
                          media: f.kind === "image" ? "image" : "text",
                          content: f.data,
                          size: f.size,
                        })
                      }
                    >
                      <BookmarkPlus className="h-4 w-4" /> Save to Library
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => onRemoveFile(f.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          ))}
        </ul>
      )}

      {empty && (
        <div className="flex flex-col items-center rounded-xl border border-foreground/10 bg-foreground/[0.015] px-6 py-10 text-center">
          <p className="text-sm text-foreground/60">No sources yet.</p>
          <p className="mt-1 max-w-sm text-xs text-foreground/45">
            Upload files just for this Space, or link datasets, texts, files and links from your
            Library.
          </p>
        </div>
      )}

      <LibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Add from Library"
        description={`Link datasets, texts, files and links to “${space.name}”. Every chat in the Space can use them.`}
        confirmLabel="Add to Space"
        linkedItemIds={links.filter((l) => l.item_id).map((l) => l.item_id!)}
        linkedDatasetIds={links.filter((l) => l.dataset_id).map((l) => l.dataset_id!)}
        numCtx={numCtx}
        onConfirm={(sel) => addSources("space", space.id, sel)}
      />
    </div>
  );
}

function SourceRow({
  enabled,
  onToggle,
  icon,
  title,
  sub,
  tokens,
  onOpen,
  actions,
}: {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
  tokens: number | null;
  onOpen?: () => void;
  actions: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "group flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-foreground/[0.04]",
        !enabled && "opacity-60",
      )}
    >
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={`Use ${title}`}
        className="scale-[0.8]"
      />
      {icon}
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <span className="block truncate text-foreground/85">{title}</span>
        <span className="block truncate text-[11px] text-foreground/45">{sub}</span>
      </button>
      <span className="shrink-0 text-[11px] tabular-nums text-foreground/40">
        {tokens === null ? "image" : `~${formatTokens(tokens)}`}
      </span>
      {actions}
    </li>
  );
}
