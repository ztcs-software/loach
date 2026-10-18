import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FileUp,
  Library,
  Link2,
  MessageSquarePlus,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { formatTokens } from "@/lib/contextUsage";
import { openExternal } from "@/lib/tauri";
import { cn, formatBytes, relativeTime } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { prepareFiles, useLibraryStore } from "@/stores/libraryStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";
import type { LibraryDataset, LibraryItemMeta } from "@/types";
import {
  AddLinkDialog,
  DatasetDialog,
  useDeleteDataset,
  useDeleteLibraryItems,
} from "./LibraryDialogs";
import { LibraryPicker } from "./LibraryPicker";
import {
  DatasetIcon,
  domainOf,
  IndexBadge,
  IndexStatusPill,
  ItemIcon,
  itemTokens,
  mixLabel,
  SelectBox,
  TAB_LABELS,
  tabOf,
  typeLabel,
  type LibraryTab,
} from "./libraryUi";

const TAB_KEY = "loach.library.tab";
const TABS: LibraryTab[] = ["datasets", "texts", "files", "links"];

function readTab(): LibraryTab {
  try {
    const t = localStorage.getItem(TAB_KEY) as LibraryTab | null;
    return t && TABS.includes(t) ? t : "datasets";
  } catch {
    return "datasets";
  }
}

/** Start a fresh chat with Library items or datasets already attached. */
async function startChatWith(sel: { itemIds: string[]; datasetIds: string[] }) {
  useSpaceStore.getState().setViewingSpace(null);
  useUIStore.getState().setSidebarTab("chats");
  const session = await useChatStore.getState().newSession({ spaceId: null });
  await useLibraryStore.getState().addSources("session", session.id, sel);
}

/**
 * The Library: one place for the texts, files and links the user feeds to
 * models, grouped into datasets. Items are stored once and linked — a chat
 * or Space that uses an item sees its latest version.
 *
 * Reached via the "Library" sidebar entry; see `App.tsx` for the routing.
 */
export function LibraryView() {
  const items = useLibraryStore((s) => s.items);
  const datasets = useLibraryStore((s) => s.datasets);
  const hydrated = useLibraryStore((s) => s.hydrated);
  const loadError = useLibraryStore((s) => s.error);
  const hydrate = useLibraryStore((s) => s.hydrate);
  const focusDatasetId = useLibraryStore((s) => s.focusDatasetId);
  const setFocusDataset = useLibraryStore((s) => s.setFocusDataset);
  const openTextEditor = useLibraryStore((s) => s.openTextEditor);
  const addPrepared = useLibraryStore((s) => s.addPrepared);
  const addToDataset = useLibraryStore((s) => s.addToDataset);
  const deleteItems = useDeleteLibraryItems();
  const { confirm } = useConfirm();

  const [tab, setTabState] = useState<LibraryTab>(readTab);
  const [query, setQuery] = useState("");
  const [openDatasetId, setOpenDatasetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linkOpen, setLinkOpen] = useState(false);
  const [datasetDialog, setDatasetDialog] = useState<{ id?: string; seed?: string[] } | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const setTab = (t: LibraryTab) => {
    setTabState(t);
    setSelected(new Set());
    setOpenDatasetId(null);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* remembered tab is a convenience */
    }
  };

  // Another surface asked to show a dataset (a chat's source chip, a Space).
  useEffect(() => {
    if (!focusDatasetId) return;
    setTabState("datasets");
    setOpenDatasetId(focusDatasetId);
    setFocusDataset(null);
  }, [focusDatasetId, setFocusDataset]);

  const counts: Record<LibraryTab, number> = useMemo(
    () => ({
      datasets: datasets.length,
      texts: items.filter((i) => i.kind === "text").length,
      files: items.filter((i) => i.kind === "file").length,
      links: items.filter((i) => i.kind === "link").length,
    }),
    [items, datasets],
  );

  const q = query.trim().toLowerCase();
  const matches = (i: LibraryItemMeta) =>
    !q ||
    i.title.toLowerCase().includes(q) ||
    i.preview.toLowerCase().includes(q) ||
    (i.url ?? "").toLowerCase().includes(q);
  const visibleItems = useMemo(
    () => (tab === "datasets" ? [] : items.filter((i) => tabOf(i) === tab && matches(i))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tab, q],
  );
  const visibleDatasets = useMemo(
    () =>
      datasets.filter(
        (d) => !q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
      ),
    [datasets, q],
  );
  const openDataset = openDatasetId ? datasets.find((d) => d.id === openDatasetId) : undefined;

  // ------- Upload (picker + drag-and-drop) --------------------------------

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading((n) => n + files.length);
    try {
      const { ready, failed } = await prepareFiles(files);
      for (const f of failed) {
        useToastStore.getState().push({ kind: "error", title: `Couldn't add ${f.name}`, body: f.reason });
      }
      const known = new Set(useLibraryStore.getState().items.map((i) => i.content_hash));
      const dupes = ready.filter((f) => known.has(f.hash));
      let toAdd = ready;
      if (dupes.length > 0) {
        const again = await confirm({
          title: dupes.length === 1 ? "Already in your Library" : `${dupes.length} files are already in your Library`,
          body: `${dupes.map((d) => d.name).join(", ")} — add ${dupes.length === 1 ? "it" : "them"} again anyway?`,
          confirmLabel: "Add anyway",
          cancelLabel: "Skip",
        });
        if (!again) toAdd = ready.filter((f) => !known.has(f.hash));
      }
      const added = await addPrepared(toAdd);
      if (added.length > 0) {
        if (openDataset) await addToDataset(openDataset.id, added.map((a) => a.id));
        else if (tab !== "files") setTab("files");
      }
    } finally {
      setUploading((n) => Math.max(0, n - files.length));
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files") || usePrivateChatStore.getState().open) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (dragDepth.current === 1) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (usePrivateChatStore.getState().open) return;
    void upload(Array.from(e.dataTransfer.files));
  };

  // ------- Selection ------------------------------------------------------

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selecting = selected.size > 0;

  // ------- Header action --------------------------------------------------

  let primary: { label: string; icon: React.ReactNode; onClick: () => void };
  if (tab === "datasets" && openDataset) {
    primary = { label: "Add items", icon: <Plus className="h-4 w-4" />, onClick: () => setPickerFor(openDataset.id) };
  } else if (tab === "datasets") {
    primary = { label: "New dataset", icon: <Plus className="h-4 w-4" />, onClick: () => setDatasetDialog({}) };
  } else if (tab === "texts") {
    primary = { label: "New text", icon: <NotebookPen className="h-4 w-4" />, onClick: () => openTextEditor("new") };
  } else if (tab === "files") {
    primary = { label: "Upload files", icon: <Upload className="h-4 w-4" />, onClick: () => fileInputRef.current?.click() };
  } else {
    primary = { label: "Add link", icon: <Link2 className="h-4 w-4" />, onClick: () => setLinkOpen(true) };
  }

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-8 py-8 pb-28">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight text-foreground">
                <Library className="h-6 w-6 text-foreground/60" />
                Library
              </h1>
              <p className="mt-2 max-w-xl text-sm text-foreground/55">
                Texts, files and links you give your models — saved once, used anywhere. Attach them
                to a chat with <span className="font-medium text-foreground/80">+ → From Library</span>{" "}
                or <span className="font-medium text-foreground/80">#</span>, or add them to a Space's
                sources.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <IndexStatusPill />
              <Button onClick={primary.onClick} className="gap-1.5 rounded-xl">
                {primary.icon}
                {primary.label}
              </Button>
            </div>
          </header>

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div
              role="tablist"
              aria-label="Library sections"
              className="inline-flex h-10 items-center rounded-2xl border border-foreground/10 bg-foreground/[0.04] p-1 text-foreground/55"
            >
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-sm font-medium transition-all",
                    tab === t
                      ? "bg-foreground/[0.10] text-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset]"
                      : "hover:text-foreground/80",
                  )}
                >
                  {TAB_LABELS[t]}
                  <span className="text-xs tabular-nums text-foreground/40">{counts[t]}</span>
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/40" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${TAB_LABELS[tab].toLowerCase()}`}
                aria-label="Search the Library"
                className="h-10 rounded-2xl pl-9"
              />
            </div>
          </div>

          {!hydrated ? (
            <LoadingGrid />
          ) : loadError ? (
            <div className="mx-auto mt-10 flex max-w-md flex-col items-center rounded-3xl border border-dashed border-destructive/25 bg-destructive/[0.04] px-8 py-14 text-center">
              <h2 className="text-base font-semibold text-foreground/85">Couldn't load the Library</h2>
              <p className="mt-2 text-sm text-foreground/55">{loadError}</p>
              <Button onClick={() => void hydrate()} variant="outline" size="sm" className="mt-5 gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          ) : tab === "datasets" ? (
            openDataset ? (
              <DatasetDetail
                dataset={openDataset}
                items={items}
                onBack={() => setOpenDatasetId(null)}
                onEdit={() => setDatasetDialog({ id: openDataset.id })}
                onAddItems={() => setPickerFor(openDataset.id)}
                onUpload={() => fileInputRef.current?.click()}
              />
            ) : visibleDatasets.length === 0 ? (
              q ? (
                <NoMatches />
              ) : (
                <EmptyState
                  icon={<DatasetIcon size="lg" />}
                  title="No datasets yet"
                  description="Group texts, files and links into a dataset, then attach the whole set to a chat or Space in one click."
                  cta={
                    <Button onClick={() => setDatasetDialog({})} className="gap-1.5 rounded-xl">
                      <Plus className="h-4 w-4" />
                      New dataset
                    </Button>
                  }
                />
              )
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visibleDatasets.map((d) => (
                  <DatasetCard
                    key={d.id}
                    dataset={d}
                    items={items}
                    onOpen={() => setOpenDatasetId(d.id)}
                    onEdit={() => setDatasetDialog({ id: d.id })}
                  />
                ))}
              </div>
            )
          ) : visibleItems.length === 0 ? (
            q ? <NoMatches /> : <EmptyTab tab={tab} onAction={primary.onClick} />
          ) : tab === "texts" ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visibleItems.map((i) => (
                <TextCard
                  key={i.id}
                  item={i}
                  selected={selected.has(i.id)}
                  selecting={selecting}
                  onToggle={() => toggleSelected(i.id)}
                />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
              {visibleItems.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  selected={selected.has(i.id)}
                  selecting={selecting}
                  onToggle={() => toggleSelected(i.id)}
                />
              ))}
            </ul>
          )}

          {uploading > 0 && (
            <p className="mt-4 flex items-center gap-2 text-xs text-foreground/55">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Reading {uploading} file{uploading === 1 ? "" : "s"}…
            </p>
          )}
        </div>
      </ScrollArea>

      {selecting && (
        <SelectionBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          onAddTo={async (datasetId) => {
            await addToDataset(datasetId, [...selected]);
            const name = datasets.find((d) => d.id === datasetId)?.name ?? "dataset";
            useToastStore.getState().push({
              kind: "info",
              title: `Added ${selected.size} to “${name}”`,
            });
            setSelected(new Set());
          }}
          onNewDataset={() => setDatasetDialog({ seed: [...selected] })}
          onChat={() => void startChatWith({ itemIds: [...selected], datasetIds: [] })}
          onDelete={async () => {
            if (await deleteItems([...selected])) setSelected(new Set());
          }}
        />
      )}

      {dragging && (
        <div className="drop-zone-hint pointer-events-none absolute inset-4 z-20 flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-primary/50 text-sm font-semibold text-orange-700 dark:text-orange-100">
          <FileUp className="h-6 w-6" strokeWidth={2} />
          <span>Drop files to add them to {openDataset ? `“${openDataset.name}”` : "your Library"}</span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <AddLinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onAdded={(id) => {
          if (openDataset) void addToDataset(openDataset.id, [id]);
        }}
      />
      <DatasetDialog
        open={!!datasetDialog}
        onOpenChange={(o) => !o && setDatasetDialog(null)}
        datasetId={datasetDialog?.id}
        seedItemIds={datasetDialog?.seed}
        onSaved={(id) => {
          if (datasetDialog?.seed) {
            setSelected(new Set());
            setTab("datasets");
            setOpenDatasetId(id);
          } else if (!datasetDialog?.id) {
            setOpenDatasetId(id);
          }
        }}
      />
      <LibraryPicker
        open={!!pickerFor}
        onOpenChange={(o) => !o && setPickerFor(null)}
        title="Add to dataset"
        description="Pick texts, files and links to include. They stay in your Library — the dataset just groups them."
        confirmLabel="Add to dataset"
        allowDatasets={false}
        linkedItemIds={datasets.find((d) => d.id === pickerFor)?.item_ids ?? []}
        onConfirm={async (sel) => {
          if (pickerFor) await addToDataset(pickerFor, sel.itemIds);
        }}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

function useMembers(dataset: LibraryDataset, items: LibraryItemMeta[]): LibraryItemMeta[] {
  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return dataset.item_ids.map((id) => byId.get(id)).filter((i): i is LibraryItemMeta => !!i);
  }, [dataset.item_ids, items]);
}

function DatasetCard({
  dataset,
  items,
  onOpen,
  onEdit,
}: {
  dataset: LibraryDataset;
  items: LibraryItemMeta[];
  onOpen: () => void;
  onEdit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const deleteDataset = useDeleteDataset();
  const members = useMembers(dataset, items);
  const tokens = members.reduce((n, i) => n + itemTokens(i), 0);
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open dataset: ${dataset.name}`}
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
      <header className="flex items-start gap-3">
        <DatasetIcon />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-1 text-[15px] font-semibold text-foreground/90">{dataset.name}</h3>
          <p className="mt-0.5 text-[11.5px] text-foreground/45">{mixLabel(members)}</p>
        </div>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Dataset actions"
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
              <Library className="h-4 w-4" /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" /> Rename / describe
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={members.length === 0}
              onSelect={() => void startChatWith({ itemIds: [], datasetIds: [dataset.id] })}
            >
              <MessageSquarePlus className="h-4 w-4" /> Chat with it
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void deleteDataset(dataset.id)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <p
        className={cn(
          "mt-3 line-clamp-2 text-[13px] leading-relaxed",
          dataset.description ? "text-foreground/60" : "italic text-foreground/35",
        )}
      >
        {dataset.description || "No description"}
      </p>

      {members.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {members.slice(0, 3).map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-[12px] text-foreground/60">
              <ItemIcon item={m} size="sm" />
              <span className="truncate">{m.title}</span>
            </li>
          ))}
          {members.length > 3 && (
            <li className="pl-9 text-[11.5px] text-foreground/40">+{members.length - 3} more</li>
          )}
        </ul>
      )}

      <div className="flex-1" />

      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
        <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-foreground/45">
          <span className="tabular-nums">~{formatTokens(tokens)} tokens</span>
          <span aria-hidden className="text-foreground/25">·</span>
          <span className="truncate" title={new Date(dataset.updated_at).toLocaleString()}>
            {relativeTime(dataset.updated_at)}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={members.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            void startChatWith({ itemIds: [], datasetIds: [dataset.id] });
          }}
          className="h-8 gap-1 rounded-lg px-3 text-xs"
        >
          <MessageSquarePlus className="h-3 w-3" />
          Chat
        </Button>
      </footer>
    </article>
  );
}

function DatasetDetail({
  dataset,
  items,
  onBack,
  onEdit,
  onAddItems,
  onUpload,
}: {
  dataset: LibraryDataset;
  items: LibraryItemMeta[];
  onBack: () => void;
  onEdit: () => void;
  onAddItems: () => void;
  onUpload: () => void;
}) {
  const members = useMembers(dataset, items);
  const setDatasetItems = useLibraryStore((s) => s.setDatasetItems);
  const deleteDataset = useDeleteDataset();
  const tokens = members.reduce((n, i) => n + itemTokens(i), 0);
  const remove = (id: string) =>
    void setDatasetItems(
      dataset.id,
      dataset.item_ids.filter((x) => x !== id),
    );
  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-foreground/55 transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All datasets
      </button>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-foreground/10 bg-foreground/[0.025] p-5">
        <div className="flex min-w-0 items-start gap-4">
          <DatasetIcon size="lg" />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{dataset.name}</h2>
            {dataset.description && (
              <p className="mt-1 max-w-2xl text-sm text-foreground/60">{dataset.description}</p>
            )}
            <p className="mt-2 text-xs text-foreground/45">
              {mixLabel(members)} · ~{formatTokens(tokens)} tokens · updated {relativeTime(dataset.updated_at)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-1.5 rounded-lg"
            disabled={members.length === 0}
            onClick={() => void startChatWith({ itemIds: [], datasetIds: [dataset.id] })}
          >
            <MessageSquarePlus className="h-4 w-4" />
            Chat with it
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Dataset actions" className="rounded-lg">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-4 w-4" /> Rename / describe
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onUpload}>
                <Upload className="h-4 w-4" /> Upload files into it
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void deleteDataset(dataset.id).then((ok) => ok && onBack())}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4" /> Delete dataset
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {members.length === 0 ? (
        <EmptyState
          icon={<DatasetIcon size="lg" />}
          title="This dataset is empty"
          description="Add texts, files and links from your Library, or drop files here to upload them straight into it."
          cta={
            <Button onClick={onAddItems} className="gap-1.5 rounded-xl">
              <Plus className="h-4 w-4" />
              Add items
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
          {members.map((m) => (
            <ItemRow key={m.id} item={m} onRemoveFromDataset={() => remove(m.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function ItemMenu({ item, onOpenChange }: { item: LibraryItemMeta; onOpenChange?: (o: boolean) => void }) {
  const datasets = useLibraryStore((s) => s.datasets);
  const addToDataset = useLibraryStore((s) => s.addToDataset);
  const openPreview = useLibraryStore((s) => s.openPreview);
  const openTextEditor = useLibraryStore((s) => s.openTextEditor);
  const refreshLink = useLibraryStore((s) => s.refreshLink);
  const deleteItems = useDeleteLibraryItems();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange?.(o);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${item.title}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "rounded-md p-1 text-foreground/45 transition-opacity hover:bg-foreground/10 hover:text-foreground",
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} className="min-w-[200px]">
        <DropdownMenuItem onSelect={() => openPreview(item.id)}>
          <Search className="h-4 w-4" /> Preview
        </DropdownMenuItem>
        {item.kind === "text" && (
          <DropdownMenuItem onSelect={() => openTextEditor(item.id)}>
            <Pencil className="h-4 w-4" /> Edit
          </DropdownMenuItem>
        )}
        {item.kind === "link" && (
          <>
            <DropdownMenuItem onSelect={() => void refreshLink(item.id)}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => item.url && void openExternal(item.url)}>
              <ExternalLink className="h-4 w-4" /> Open in browser
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => void startChatWith({ itemIds: [item.id], datasetIds: [] })}>
          <MessageSquarePlus className="h-4 w-4" /> Chat about it
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Plus className="h-4 w-4" /> Add to dataset
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 min-w-[180px] overflow-y-auto">
            {datasets.length === 0 && <DropdownMenuItem disabled>No datasets yet</DropdownMenuItem>}
            {datasets.map((d) => {
              const inIt = d.item_ids.includes(item.id);
              return (
                <DropdownMenuItem key={d.id} disabled={inIt} onSelect={() => void addToDataset(d.id, [item.id])}>
                  <DatasetIcon size="sm" />
                  <span className="truncate">{d.name}</span>
                  {inIt && <span className="ml-auto text-[11px] text-foreground/45">Added</span>}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void deleteItems([item.id])}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TextCard({
  item,
  selected,
  selecting,
  onToggle,
}: {
  item: LibraryItemMeta;
  selected: boolean;
  selecting: boolean;
  onToggle: () => void;
}) {
  const openPreview = useLibraryStore((s) => s.openPreview);
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open text: ${item.title}`}
      onClick={() => (selecting ? onToggle() : openPreview(item.id))}
      onKeyDown={(e) => {
        if (e.key === "Enter") openPreview(item.id);
      }}
      className={cn(
        "group relative flex h-full min-h-[168px] cursor-pointer flex-col rounded-2xl border bg-foreground/[0.025] p-5 transition-colors",
        "hover:border-foreground/20 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        selected ? "border-primary/50 bg-primary/[0.05]" : "border-foreground/10",
      )}
    >
      <header className="flex items-start gap-3">
        <ItemIcon item={item} />
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold text-foreground/90">{item.title}</h3>
        <SelectBox checked={selected} visible={selecting} onToggle={onToggle} label={`Select ${item.title}`} />
        <ItemMenu item={item} />
      </header>
      <p className="mt-3 line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed text-foreground/55">
        {item.preview}
      </p>
      <div className="flex-1" />
      <footer className="mt-4 flex items-center gap-2 border-t border-foreground/[0.06] pt-3 text-[10.5px] text-foreground/45">
        <span className="tabular-nums">~{formatTokens(itemTokens(item))} tokens</span>
        <span aria-hidden className="text-foreground/25">·</span>
        <span title={new Date(item.updated_at).toLocaleString()}>{relativeTime(item.updated_at)}</span>
        <span className="ml-auto">
          <IndexBadge item={item} />
        </span>
      </footer>
    </article>
  );
}

function ItemRow({
  item,
  selected = false,
  selecting = false,
  onToggle,
  onRemoveFromDataset,
}: {
  item: LibraryItemMeta;
  selected?: boolean;
  selecting?: boolean;
  onToggle?: () => void;
  /** Shown instead of the selection box inside a dataset. */
  onRemoveFromDataset?: () => void;
}) {
  const openPreview = useLibraryStore((s) => s.openPreview);
  const refreshLink = useLibraryStore((s) => s.refreshLink);
  const [refreshing, setRefreshing] = useState(false);
  const sub =
    item.kind === "link"
      ? [domainOf(item.url), item.fetched_at ? `fetched ${relativeTime(item.fetched_at)}` : null]
      : [typeLabel(item), formatBytes(item.size)];
  return (
    <li
      onClick={() => (selecting && onToggle ? onToggle() : openPreview(item.id))}
      className={cn(
        "group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.04]",
        selected && "bg-primary/[0.06]",
      )}
    >
      {onToggle && (
        <SelectBox checked={selected} visible={selecting} onToggle={onToggle} label={`Select ${item.title}`} />
      )}
      <ItemIcon item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-foreground/90">{item.title}</span>
          <IndexBadge item={item} />
        </div>
        <div className="truncate text-[11.5px] text-foreground/45">
          {sub.filter(Boolean).join(" · ")}
        </div>
      </div>
      <span className="hidden shrink-0 text-[11.5px] tabular-nums text-foreground/45 sm:inline">
        {item.media === "text" ? `~${formatTokens(itemTokens(item))} tokens` : "image"}
      </span>
      <span
        className="hidden w-20 shrink-0 text-right text-[11.5px] text-foreground/40 md:inline"
        title={new Date(item.created_at).toLocaleString()}
      >
        {relativeTime(item.created_at)}
      </span>
      <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        {item.kind === "link" && (
          <button
            type="button"
            aria-label="Refresh link"
            title="Fetch the page again"
            onClick={() => {
              setRefreshing(true);
              void refreshLink(item.id).finally(() => setRefreshing(false));
            }}
            className={cn(
              "rounded-md p-1 text-foreground/45 transition-opacity hover:bg-foreground/10 hover:text-foreground",
              refreshing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </button>
        )}
        {onRemoveFromDataset ? (
          <button
            type="button"
            aria-label={`Remove ${item.title} from the dataset`}
            title="Remove from dataset (stays in your Library)"
            onClick={onRemoveFromDataset}
            className="rounded-md p-1 text-foreground/45 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <ItemMenu item={item} />
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Selection bar
// ---------------------------------------------------------------------------

function SelectionBar({
  count,
  onClear,
  onAddTo,
  onNewDataset,
  onChat,
  onDelete,
}: {
  count: number;
  onClear: () => void;
  onAddTo: (datasetId: string) => void;
  onNewDataset: () => void;
  onChat: () => void;
  onDelete: () => void;
}) {
  const datasets = useLibraryStore((s) => s.datasets);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-4">
      <div className="glass-panel pointer-events-auto flex items-center gap-1.5 rounded-full py-1.5 pl-4 pr-1.5 shadow-xl">
        <span className="mr-1 text-sm font-medium tabular-nums text-foreground/85">{count} selected</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="gap-1.5 rounded-full">
              <Plus className="h-3.5 w-3.5" />
              Add to dataset
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top" className="max-h-72 min-w-[200px] overflow-y-auto">
            <DropdownMenuItem onSelect={onNewDataset}>
              <Plus className="h-4 w-4" /> New dataset…
            </DropdownMenuItem>
            {datasets.length > 0 && <DropdownMenuSeparator />}
            {datasets.length > 0 && (
              <DropdownMenuLabel className="text-xs text-foreground/50">Existing</DropdownMenuLabel>
            )}
            {datasets.map((d) => (
              <DropdownMenuItem key={d.id} onSelect={() => onAddTo(d.id)}>
                <DatasetIcon size="sm" />
                <span className="truncate">{d.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" className="gap-1.5 rounded-full" onClick={onChat}>
          <MessageSquarePlus className="h-3.5 w-3.5" />
          Chat
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 rounded-full text-foreground/70 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
        <button
          type="button"
          aria-label="Clear selection"
          onClick={onClear}
          className="ml-0.5 grid h-8 w-8 place-items-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty / loading states — visual mirror of Spaces and Snippets.
// ---------------------------------------------------------------------------

const EMPTY_COPY: Record<Exclude<LibraryTab, "datasets">, { title: string; body: string; cta: string; icon: React.ReactNode }> = {
  texts: {
    title: "No texts yet",
    body: "Write notes, specs or guidelines once and reuse them in any chat — edit them here and every chat and Space using them picks up the change.",
    cta: "New text",
    icon: <NotebookPen className="h-6 w-6 text-amber-600 dark:text-amber-300" />,
  },
  files: {
    title: "No files yet",
    body: "Upload PDFs, Word documents, code, notes or images — or drop them anywhere on this page. Loach extracts the text once and keeps it here.",
    cta: "Upload files",
    icon: <FileUp className="h-6 w-6 text-sky-600 dark:text-sky-300" />,
  },
  links: {
    title: "No links yet",
    body: "Add a web page and Loach keeps a snapshot of its text, so models can read it offline. Refresh it whenever the page changes.",
    cta: "Add link",
    icon: <Link2 className="h-6 w-6 text-emerald-600 dark:text-emerald-300" />,
  },
};

function EmptyTab({ tab, onAction }: { tab: Exclude<LibraryTab, "datasets">; onAction: () => void }) {
  const c = EMPTY_COPY[tab];
  return (
    <EmptyState
      icon={c.icon}
      title={c.title}
      description={c.body}
      cta={
        <Button onClick={onAction} className="gap-1.5 rounded-xl">
          <Plus className="h-4 w-4" />
          {c.cta}
        </Button>
      }
    />
  );
}

function EmptyState({
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
    <div className="mx-auto mt-6 flex max-w-md flex-col items-center justify-center rounded-3xl border border-dashed border-foreground/10 bg-foreground/[0.015] px-8 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-foreground/[0.05]">
        {icon}
      </div>
      <h2 className="text-base font-semibold text-foreground/85">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-foreground/55">{description}</p>
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  );
}

function NoMatches() {
  return <p className="mt-10 text-center text-sm text-foreground/45">Nothing matches your search.</p>;
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy aria-label="Loading">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-36 animate-pulse rounded-2xl border border-foreground/10 bg-foreground/[0.03]"
        />
      ))}
    </div>
  );
}
