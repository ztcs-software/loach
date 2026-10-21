import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Database,
  ExternalLink,
  Eye,
  FileUp,
  Layers,
  Library,
  Link2,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SquarePen,
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
import { useModelsStore } from "@/stores/modelsStore";
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

/** The tab the user last picked, or null when they never have. */
function readTab(): LibraryTab | null {
  try {
    const t = localStorage.getItem(TAB_KEY) as LibraryTab | null;
    return t && TABS.includes(t) ? t : null;
  } catch {
    return null;
  }
}

/** Start a fresh chat with Library items or datasets already attached. */
async function startChatWith(sel: { itemIds: string[]; datasetIds: string[] }) {
  useSpaceStore.getState().setViewingSpace(null);
  useUIStore.getState().setSidebarTab("chats");
  const session = await useChatStore.getState().newSession({ spaceId: null });
  await useLibraryStore.getState().addSources("session", session.id, sel);
}

/** Link Library items or datasets into a Space's sources — the Library side
 *  of the Space's own "From Library" picker. Already-linked ones are skipped
 *  by the backend. Returns whether it worked. */
async function addToSpace(spaceId: string, sel: { itemIds: string[]; datasetIds: string[] }) {
  const toast = useToastStore.getState().push;
  const name = useSpaceStore.getState().spaces.find((s) => s.id === spaceId)?.name ?? "the Space";
  try {
    await useLibraryStore.getState().addSources("space", spaceId, sel);
  } catch (e) {
    toast({ kind: "error", title: `Couldn't add to “${name}”`, body: e instanceof Error ? e.message : String(e) });
    return false;
  }
  const n = sel.itemIds.length + sel.datasetIds.length;
  toast({
    kind: "info",
    title: n === 1 ? `Added to “${name}”` : `Added ${n} to “${name}”`,
    body: "Every chat in the Space can use it.",
    action: {
      label: "Open",
      onClick: () => {
        useModelsStore.getState().setViewingModel(null);
        useUIStore.getState().setSidebarTab("spaces");
        useSpaceStore.getState().setViewingSpace(spaceId, "files");
      },
    },
  });
  return true;
}

/** "Add to Space ▸" for an item's or a dataset's menu. */
function AddToSpaceSubmenu({ sel }: { sel: { itemIds: string[]; datasetIds: string[] } }) {
  const spaces = useSpaceStore((s) => s.spaces);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Layers className="h-4 w-4" /> Add to Space
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 min-w-[180px] overflow-y-auto">
        {spaces.length === 0 && <DropdownMenuItem disabled>No Spaces yet</DropdownMenuItem>}
        {spaces.map((sp) => (
          <DropdownMenuItem key={sp.id} onSelect={() => void addToSpace(sp.id, sel)}>
            <span className="truncate">{sp.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
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
  const viewingDatasetId = useLibraryStore((s) => s.viewingDatasetId);
  const setViewingDataset = useLibraryStore((s) => s.setViewingDataset);
  const openTextEditor = useLibraryStore((s) => s.openTextEditor);
  const addPrepared = useLibraryStore((s) => s.addPrepared);
  const addToDataset = useLibraryStore((s) => s.addToDataset);
  const deleteItems = useDeleteLibraryItems();
  const { confirm } = useConfirm();

  const [pickedTab, setTabState] = useState<LibraryTab | null>(readTab);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linkOpen, setLinkOpen] = useState(false);
  const [datasetDialog, setDatasetDialog] = useState<{ id?: string; seed?: string[] } | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // The selection survives a tab switch, as it does in the Library picker,
  // so texts and files can be picked together for one dataset or chat.
  const setTab = (t: LibraryTab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* remembered tab is a convenience */
    }
  };

  const q = query.trim().toLowerCase();
  const matches = (i: LibraryItemMeta) =>
    !q ||
    i.title.toLowerCase().includes(q) ||
    i.preview.toLowerCase().includes(q) ||
    (i.url ?? "").toLowerCase().includes(q);
  const datasetMatches = (d: LibraryDataset) =>
    !q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q);

  // What each tab holds — or, while searching, how many of its entries match,
  // so a search that comes up empty on this tab shows where the hits are.
  const counts: Record<LibraryTab, number> = useMemo(
    () => ({
      datasets: datasets.filter(datasetMatches).length,
      texts: items.filter((i) => i.kind === "text" && matches(i)).length,
      files: items.filter((i) => i.kind === "file" && matches(i)).length,
      links: items.filter((i) => i.kind === "link" && matches(i)).length,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, datasets, q],
  );

  // A Library never opened before lands on the first section with something
  // in it, rather than on Datasets: a new user was greeted by "New dataset"
  // before there was anything to put in one. With nothing anywhere, Files —
  // dropping a document in is the usual first step.
  const tab: LibraryTab =
    pickedTab ??
    TABS.find((t) => (t === "datasets" ? datasets.length > 0 : items.some((i) => tabOf(i) === t))) ??
    "files";
  const visibleItems = useMemo(
    () => (tab === "datasets" ? [] : items.filter((i) => tabOf(i) === tab && matches(i))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tab, q],
  );
  const visibleDatasets = useMemo(
    () => datasets.filter(datasetMatches),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datasets, q],
  );
  // Tabs other than this one that have hits, for the "no matches" line.
  const elsewhere = TABS.filter((t) => t !== tab && counts[t] > 0);
  // A dataset gets its own page, like a Space; an id that no longer
  // resolves (deleted elsewhere) falls back to the list.
  const openDataset = viewingDatasetId ? datasets.find((d) => d.id === viewingDatasetId) : undefined;

  // ------- Upload (picker + drag-and-drop) --------------------------------

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading((n) => n + files.length);
    try {
      const { ready, failed } = await prepareFiles(files);
      for (const f of failed) {
        useToastStore.getState().push({ kind: "error", title: `Couldn't add ${f.name}`, body: f.reason });
      }
      const known = new Map(useLibraryStore.getState().items.map((i) => [i.content_hash, i.id]));
      const dupes = ready.filter((f) => known.has(f.hash));
      let toAdd = ready;
      // Skipped duplicates: the copies already in the Library.
      let existingIds: string[] = [];
      if (dupes.length > 0) {
        const again = await confirm({
          title: dupes.length === 1 ? "Already in your Library" : `${dupes.length} files are already in your Library`,
          body: `${dupes.map((d) => d.name).join(", ")} — add ${dupes.length === 1 ? "it" : "them"} again anyway?`,
          confirmLabel: "Add anyway",
          cancelLabel: "Skip",
        });
        if (!again) {
          toAdd = ready.filter((f) => !known.has(f.hash));
          existingIds = dupes.map((f) => known.get(f.hash)!);
        }
      }
      const added = await addPrepared(toAdd);
      if (openDataset) {
        // Uploading into a dataset means "put this in it": a skipped
        // duplicate joins as the copy the Library already has.
        const ids = [...added.map((a) => a.id), ...existingIds];
        if (ids.length > 0) await addToDataset(openDataset.id, ids);
      } else if (added.length > 0 && tab !== "files") {
        setTab("files");
      }
    } finally {
      setUploading((n) => Math.max(0, n - files.length));
    }
  };

  // The page's own handlers cover only <main>. A file dropped on the
  // sidebar or the title bar would reach the webview's default handling,
  // which opens the file in place of the app (Tauri's drag-drop is off, so
  // nothing else catches it). The composer guards the window the same way,
  // but it isn't mounted on this page.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

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
  if (tab === "datasets") {
    primary = { label: "New dataset", icon: <Plus className="h-4 w-4" />, onClick: () => setDatasetDialog({}) };
  } else if (tab === "texts") {
    primary = { label: "New text", icon: <NotebookPen className="h-4 w-4" />, onClick: () => openTextEditor("new") };
  } else if (tab === "files") {
    primary = { label: "Upload files", icon: <Upload className="h-4 w-4" />, onClick: () => fileInputRef.current?.click() };
  } else {
    primary = { label: "Add link", icon: <Link2 className="h-4 w-4" />, onClick: () => setLinkOpen(true) };
  }

  const uploadingNote = uploading > 0 && (
    <p className="mt-4 flex items-center gap-2 text-xs text-foreground/55">
      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      Reading {uploading} file{uploading === 1 ? "" : "s"}…
    </p>
  );

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
      {/* Keyed so moving between the list and a dataset page starts at the
          top, as moving between the Spaces grid and a Space does. */}
      <ScrollArea key={openDataset?.id ?? "list"} className="flex-1">
        {openDataset ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-12 pt-8">
            <DatasetDetail
              dataset={openDataset}
              items={items}
              onBack={() => {
                setTab("datasets");
                setViewingDataset(null);
              }}
              onEdit={() => setDatasetDialog({ id: openDataset.id })}
              onAddItems={() => setPickerFor(openDataset.id)}
              onUpload={() => fileInputRef.current?.click()}
            />
            {uploadingNote}
          </div>
        ) : (
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
                  placeholder="Search the Library"
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
              visibleDatasets.length === 0 ? (
                q ? (
                  <NoMatches elsewhere={elsewhere} counts={counts} onPick={setTab} />
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
                      onOpen={() => setViewingDataset(d.id)}
                      onEdit={() => setDatasetDialog({ id: d.id })}
                    />
                  ))}
                </div>
              )
            ) : visibleItems.length === 0 ? (
              q ? (
                <NoMatches elsewhere={elsewhere} counts={counts} onPick={setTab} />
              ) : (
                <EmptyTab tab={tab} action={primary} />
              )
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

            {uploadingNote}
          </div>
        )}
      </ScrollArea>

      {selecting && (
        <SelectionBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          // What this tab lists that isn't picked yet; nothing to add on
          // Datasets, which can't be selected.
          selectAll={(() => {
            const rest = visibleItems.filter((i) => !selected.has(i.id));
            return rest.length > 0
              ? () => setSelected((prev) => new Set([...prev, ...rest.map((i) => i.id)]))
              : null;
          })()}
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
          onAddToSpace={async (spaceId) => {
            if (await addToSpace(spaceId, { itemIds: [...selected], datasetIds: [] })) setSelected(new Set());
          }}
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
            setViewingDataset(id);
          } else if (!datasetDialog?.id) {
            setViewingDataset(id);
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
        // Only the card's own keys: Enter on its Chat or ⋯ button (or a menu
        // item, which bubbles here through the portal) belongs to that control.
        if (e.target !== e.currentTarget) return;
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
            <DropdownMenuItem
              disabled={members.length === 0}
              onSelect={() => void startChatWith({ itemIds: [], datasetIds: [dataset.id] })}
            >
              <SquarePen className="h-4 w-4" /> New chat
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" /> Edit details
            </DropdownMenuItem>
            <AddToSpaceSubmenu sel={{ itemIds: [], datasetIds: [dataset.id] }} />
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
          <SquarePen className="h-3 w-3" />
          New chat
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
  // Laid out like SpaceView — breadcrumb, title row with its actions menu,
  // description and meta chips — so opening a dataset feels like opening a
  // Space.
  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1.5 text-xs text-foreground/45 transition-colors hover:text-foreground/75"
      >
        <span>Library</span>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground/55">{dataset.name}</span>
      </button>

      <div className="flex items-center gap-3">
        <Database className="h-7 w-7 shrink-0 text-foreground/65" strokeWidth={1.75} />
        <h1 className="flex-1 truncate text-3xl font-semibold tracking-tight text-foreground">
          {dataset.name}
        </h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dataset actions"
              className="rounded-xl text-foreground/55 hover:bg-foreground/10 hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" /> Edit details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onUpload}>
              <Upload className="h-4 w-4" /> Upload files into it
            </DropdownMenuItem>
            <AddToSpaceSubmenu sel={{ itemIds: [], datasetIds: [dataset.id] }} />
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

      <div className="ml-10 mt-1.5">
        <p className={cn("text-sm", dataset.description ? "text-foreground/55" : "italic text-foreground/30")}>
          {dataset.description || "No description"}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <MetaChip>{mixLabel(members)}</MetaChip>
          {members.length > 0 && <MetaChip>~{formatTokens(tokens)} tokens</MetaChip>}
          <MetaChip>Updated {relativeTime(dataset.updated_at)}</MetaChip>
        </div>
      </div>

      {members.length === 0 ? (
        <div className="mt-10">
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
        </div>
      ) : (
        <>
          <div className="mb-3 mt-10 flex items-center justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">Items</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-lg"
                onClick={() => void startChatWith({ itemIds: [], datasetIds: [dataset.id] })}
              >
                <SquarePen className="h-3.5 w-3.5" />
                New chat
              </Button>
              <Button size="sm" className="gap-1.5 rounded-lg" onClick={onAddItems}>
                <Plus className="h-3.5 w-3.5" />
                Add items
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
            {members.map((m) => (
              <ItemRow key={m.id} item={m} onRemoveFromDataset={() => remove(m.id)} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Pill in the meta strip under the dataset title — SpaceView's `MetaChip`. */
function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-foreground/70">
      {children}
    </span>
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
          <Eye className="h-4 w-4" /> Preview
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
          <SquarePen className="h-4 w-4" /> New chat
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
        <AddToSpaceSubmenu sel={{ itemIds: [item.id], datasetIds: [] }} />
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
        if (e.key !== "Enter" || e.target !== e.currentTarget) return;
        if (selecting) onToggle();
        else openPreview(item.id);
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
      {/* Footer laid out like every other card's: meta left, the card's
          action right — here, as on a dataset card, a new chat with it. */}
      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
        <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-foreground/45">
          <span className="tabular-nums">~{formatTokens(itemTokens(item))} tokens</span>
          <span aria-hidden className="text-foreground/25">·</span>
          <span title={new Date(item.updated_at).toLocaleString()}>{relativeTime(item.updated_at)}</span>
          <IndexBadge item={item} />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            void startChatWith({ itemIds: [item.id], datasetIds: [] });
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
  const activate = () => (selecting && onToggle ? onToggle() : openPreview(item.id));
  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      onClick={activate}
      onKeyDown={(e) => {
        // The row's own keys only — its buttons and menu handle theirs.
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        activate();
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
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
        {item.kind === "link" ? (
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
        ) : (
          // Same width as the refresh button, so in a list mixing links with
          // other items (a dataset's page) the token and date columns line up.
          <span aria-hidden className="p-1">
            <span className="block h-3.5 w-3.5" />
          </span>
        )}
        {onRemoveFromDataset && (
          <button
            type="button"
            aria-label={`Remove ${item.title} from the dataset`}
            title="Remove from dataset (stays in your Library)"
            onClick={onRemoveFromDataset}
            className="rounded-md p-1 text-foreground/45 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <ItemMenu item={item} />
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
  selectAll,
  onAddTo,
  onNewDataset,
  onAddToSpace,
  onChat,
  onDelete,
}: {
  count: number;
  onClear: () => void;
  /** Adds the rest of this tab's entries; null when there's nothing left. */
  selectAll: (() => void) | null;
  onAddTo: (datasetId: string) => void;
  onNewDataset: () => void;
  onAddToSpace: (spaceId: string) => void;
  onChat: () => void;
  onDelete: () => void;
}) {
  const datasets = useLibraryStore((s) => s.datasets);
  const spaces = useSpaceStore((s) => s.spaces);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-4">
      <div className="glass-panel pointer-events-auto flex items-center gap-1.5 rounded-full py-1.5 pl-4 pr-1.5 shadow-xl">
        <span className="mr-1 text-sm font-medium tabular-nums text-foreground/85">{count} selected</span>
        {selectAll && (
          <Button size="sm" variant="ghost" className="rounded-full text-foreground/70" onClick={selectAll}>
            Select all
          </Button>
        )}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="gap-1.5 rounded-full">
              <Layers className="h-3.5 w-3.5" />
              Add to Space
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top" className="max-h-72 min-w-[200px] overflow-y-auto">
            {spaces.length === 0 && <DropdownMenuItem disabled>No Spaces yet</DropdownMenuItem>}
            {spaces.map((sp) => (
              <DropdownMenuItem key={sp.id} onSelect={() => onAddToSpace(sp.id)}>
                <Layers className="h-4 w-4" />
                <span className="truncate">{sp.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" className="gap-1.5 rounded-full" onClick={onChat}>
          <SquarePen className="h-3.5 w-3.5" />
          New chat
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

const EMPTY_COPY: Record<Exclude<LibraryTab, "datasets">, { title: string; body: string; icon: React.ReactNode }> = {
  texts: {
    title: "No texts yet",
    body: "Write notes, specs or guidelines once and reuse them in any chat — edit them here and every chat and Space using them picks up the change.",
    icon: <NotebookPen className="h-6 w-6 text-amber-600 dark:text-amber-300" />,
  },
  files: {
    title: "No files yet",
    body: "Upload PDFs, Word documents, code, notes or images — or drop them anywhere on this page. Loach extracts the text once and keeps it here.",
    icon: <FileUp className="h-6 w-6 text-sky-600 dark:text-sky-300" />,
  },
  links: {
    title: "No links yet",
    body: "Add a web page and Loach keeps a snapshot of its text, so models can read it offline. Refresh it whenever the page changes.",
    icon: <Link2 className="h-6 w-6 text-emerald-600 dark:text-emerald-300" />,
  },
};

/** An empty tab's call to action is the header's own button — same label,
 *  same icon — so the two never read as different actions. */
function EmptyTab({
  tab,
  action,
}: {
  tab: Exclude<LibraryTab, "datasets">;
  action: { label: string; icon: React.ReactNode; onClick: () => void };
}) {
  const c = EMPTY_COPY[tab];
  return (
    <EmptyState
      icon={c.icon}
      title={c.title}
      description={c.body}
      cta={
        <Button onClick={action.onClick} className="gap-1.5 rounded-xl">
          {action.icon}
          {action.label}
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

/** "No matches" for this tab — with a way to the tabs that do have some, since
 *  the search only lists the open tab's entries. */
function NoMatches({
  elsewhere,
  counts,
  onPick,
}: {
  elsewhere: LibraryTab[];
  counts: Record<LibraryTab, number>;
  onPick: (tab: LibraryTab) => void;
}) {
  return (
    <div className="mt-10 text-center text-sm text-foreground/45">
      <p>Nothing here matches your search.</p>
      {elsewhere.length > 0 && (
        <p className="mt-2">
          Found in{" "}
          {elsewhere.map((t, i) => (
            <span key={t}>
              {i > 0 && ", "}
              <button
                type="button"
                onClick={() => onPick(t)}
                className="font-medium text-foreground/75 underline underline-offset-2 hover:text-foreground"
              >
                {TAB_LABELS[t]} ({counts[t]})
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
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
