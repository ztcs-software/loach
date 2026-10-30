import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/Markdown";
import { useConfirm } from "@/components/ConfirmDialog";
import { dialogEnter } from "@/lib/shortcuts";
import { libraryUsage, openExternal } from "@/lib/tauri";
import { cn, formatBytes, relativeTime } from "@/lib/utils";
import { safeImageMime } from "@/lib/files";
import { useLibraryStore } from "@/stores/libraryStore";
import { useToastStore } from "@/stores/toastStore";
import type { LibraryItem } from "@/types";
import {
  DatasetIcon,
  IndexBadge,
  ItemIcon,
  itemTokens,
  tokensLabel,
  typeLabel,
} from "./libraryUi";

// ---------------------------------------------------------------------------
// Delete — one flow for every surface, naming what links to the items.
// ---------------------------------------------------------------------------

/** Delete Library items after a confirmation that says where they're used. */
export function useDeleteLibraryItems() {
  const { confirm } = useConfirm();
  const deleteItems = useLibraryStore((s) => s.deleteItems);
  return async (ids: string[]) => {
    if (ids.length === 0) return false;
    const { items, datasets } = useLibraryStore.getState();
    const names = items.filter((i) => ids.includes(i.id)).map((i) => i.title);
    const inDatasets = datasets.filter((d) => d.item_ids.some((id) => ids.includes(id)));
    let usage = { spaces: [] as string[], chats: 0 };
    try {
      // Through its datasets too: a Space or chat that links a dataset loses
      // the item just the same.
      usage = await libraryUsage({ itemIds: ids, datasetIds: inDatasets.map((d) => d.id) });
    } catch {
      /* the confirmation still works without the usage line */
    }
    const where: string[] = [];
    if (inDatasets.length) where.push(`${inDatasets.length} dataset${inDatasets.length === 1 ? "" : "s"}`);
    if (usage.spaces.length) where.push(`Space${usage.spaces.length === 1 ? "" : "s"} ${usage.spaces.map((s) => `“${s}”`).join(", ")}`);
    if (usage.chats) where.push(`${usage.chats} chat${usage.chats === 1 ? "" : "s"}`);
    const ok = await confirm({
      title: ids.length === 1 ? `Delete “${names[0] ?? "item"}”?` : `Delete ${ids.length} items?`,
      body:
        (where.length ? `Used in ${where.join(", ")} — it will be removed from them too. ` : "") +
        "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    return ok && (await deleteItems(ids));
  };
}

/** Delete a dataset (its items stay in the Library). */
export function useDeleteDataset() {
  const { confirm } = useConfirm();
  const deleteDataset = useLibraryStore((s) => s.deleteDataset);
  return async (id: string) => {
    const ds = useLibraryStore.getState().datasets.find((d) => d.id === id);
    if (!ds) return false;
    let usage = { spaces: [] as string[], chats: 0 };
    try {
      usage = await libraryUsage({ itemIds: [], datasetIds: [id] });
    } catch {
      /* ignore */
    }
    const where: string[] = [];
    if (usage.spaces.length) where.push(`Space${usage.spaces.length === 1 ? "" : "s"} ${usage.spaces.map((s) => `“${s}”`).join(", ")}`);
    if (usage.chats) where.push(`${usage.chats} chat${usage.chats === 1 ? "" : "s"}`);
    const ok = await confirm({
      title: `Delete dataset “${ds.name}”?`,
      body:
        "Its items stay in your Library. " +
        (where.length ? `It's linked to ${where.join(" and ")}, which will lose it.` : ""),
      confirmLabel: "Delete dataset",
      destructive: true,
    });
    // The store toasts a failed delete; report it so the caller doesn't
    // navigate away from a dataset that still exists.
    return ok && (await deleteDataset(id));
  };
}

/** Delete what's selected on the Library page — items, datasets or a mix —
 *  after one confirmation. Items alone or a single dataset go through their
 *  own flows above, so those keep their exact wording. */
export function useDeleteSelection() {
  const { confirm } = useConfirm();
  const deleteItemsFlow = useDeleteLibraryItems();
  const deleteDatasetFlow = useDeleteDataset();
  const deleteItems = useLibraryStore((s) => s.deleteItems);
  const deleteDataset = useLibraryStore((s) => s.deleteDataset);
  return async (itemIds: string[], datasetIds: string[]) => {
    if (datasetIds.length === 0) return deleteItemsFlow(itemIds);
    if (itemIds.length === 0 && datasetIds.length === 1) return deleteDatasetFlow(datasetIds[0]);
    const { datasets } = useLibraryStore.getState();
    // Through the datasets the items are in too, as for items alone.
    const reach = new Set(datasetIds);
    for (const d of datasets) if (d.item_ids.some((id) => itemIds.includes(id))) reach.add(d.id);
    let usage = { spaces: [] as string[], chats: 0 };
    try {
      usage = await libraryUsage({ itemIds, datasetIds: [...reach] });
    } catch {
      /* the confirmation still works without the usage line */
    }
    const where: string[] = [];
    if (usage.spaces.length) where.push(`Space${usage.spaces.length === 1 ? "" : "s"} ${usage.spaces.map((s) => `“${s}”`).join(", ")}`);
    if (usage.chats) where.push(`${usage.chats} chat${usage.chats === 1 ? "" : "s"}`);
    const what = [
      itemIds.length ? `${itemIds.length} item${itemIds.length === 1 ? "" : "s"}` : null,
      `${datasetIds.length} dataset${datasetIds.length === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" and ");
    const ok = await confirm({
      title: `Delete ${what}?`,
      body:
        "Items inside the datasets that you didn't select stay in your Library. " +
        (where.length ? `Used in ${where.join(", ")} — they'll lose them. ` : "") +
        "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return false;
    for (const id of datasetIds) await deleteDataset(id);
    return itemIds.length > 0 ? deleteItems(itemIds) : true;
  };
}

// ---------------------------------------------------------------------------
// Text editor (global — opened from the Library or an item preview)
// ---------------------------------------------------------------------------

export function TextEditorDialog() {
  const { confirm } = useConfirm();
  const target = useLibraryStore((s) => s.editTextTarget);
  const close = () => useLibraryStore.getState().openTextEditor(null);
  const createText = useLibraryStore((s) => s.createText);
  const updateText = useLibraryStore((s) => s.updateText);
  const getContents = useLibraryStore((s) => s.getContents);
  const item = useLibraryStore((s) =>
    target && target !== "new" ? s.items.find((i) => i.id === target) : undefined,
  );
  // A draft kept for this target — the dialog was unmounted by the app lock
  // while it was open (see `editDraft`).
  const keptDraft = () => {
    const d = useLibraryStore.getState().editDraft;
    return d && d.target === target ? d : null;
  };
  const [title, setTitle] = useState(() => keptDraft()?.title ?? "");
  const [body, setBody] = useState(() => keptDraft()?.body ?? "");
  const [loading, setLoading] = useState(false);
  // The saved text couldn't be read: there's nothing to edit, and saving
  // would overwrite the item with whatever the field holds.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // State lags a render behind, so two quick Ctrl+Enters both saw `saving`
  // false and created the text twice. A ref holds the save synchronously.
  const savingRef = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  // What the fields held once the editor opened (and its text loaded):
  // closing with anything else asks first. Null for a draft kept across an
  // app lock, whose saved state isn't known here — any text in it counts.
  const [baseline, setBaseline] = useState<{ title: string; body: string } | null>(null);
  const dirty =
    !loading &&
    (baseline
      ? title !== baseline.title || body !== baseline.body
      : title.trim() !== "" || body.trim() !== "");

  useEffect(() => {
    setError(null);
    setLoadFailed(false);
    if (!target) return;
    const kept = keptDraft();
    if (kept) {
      setTitle(kept.title);
      setBody(kept.body);
      setBaseline(null);
      return;
    }
    if (target === "new") {
      setTitle("");
      setBody("");
      setBaseline({ title: "", body: "" });
      return;
    }
    const savedTitle = item?.title ?? "";
    setTitle(savedTitle);
    // Not the last text edited: if this load fails, Save must not write that
    // into this item.
    setBody("");
    setLoading(true);
    getContents([target])
      .then(([full]) => {
        const content = full?.content ?? "";
        setBody(content);
        setBaseline({ title: savedTitle, body: content });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoadFailed(true);
        setBaseline({ title: savedTitle, body: "" });
      })
      .finally(() => setLoading(false));
    // Re-seed only when a different item opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Keep the store's copy of the draft current, so it outlives an unmount.
  useEffect(() => {
    if (!target || loading || loadFailed) return;
    useLibraryStore.setState({ editDraft: { target, title, body } });
  }, [target, title, body, loading, loadFailed]);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (target === "new") await createText(title.trim(), body);
      else if (target) await updateText(target, title.trim(), body);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Escape, the backdrop, ✕ and Cancel all come through here, so none of them
  // can throw typed text away without asking.
  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: target === "new" ? "This text hasn't been saved yet." : "Your edits to this text haven't been saved.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      }))
    ) {
      return;
    }
    close();
  };

  const canSave = !saving && !loading && !loadFailed && !!title.trim() && !!body.trim();
  const tokens = Math.ceil(body.length / 4);
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && void requestClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target === "new" ? "New text" : "Edit text"}</DialogTitle>
          <DialogDescription>
            Notes, specs, guidelines — anything you want models to know. Markdown works.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-1 space-y-3">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void save(), { ready: canSave, next: bodyRef.current })}
              placeholder="e.g. Brand voice guide"
              maxLength={120}
              autoFocus
            />
          </Field>
          <Field label="Text">
            <span className="relative block">
              <Textarea
                ref={bodyRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={loading || loadFailed}
                placeholder="Write or paste the text…"
                className="min-h-[340px] rounded-2xl border-foreground/10 bg-foreground/[0.05] text-[13.5px] leading-relaxed"
                onKeyDown={(e) => dialogEnter(e, () => void save(), { ready: canSave })}
              />
              {loading && (
                <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-foreground/45" />
              )}
            </span>
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-xs tabular-nums text-foreground/45">
            {body.length.toLocaleString()} characters · {tokensLabel(tokens)}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void requestClose()} className="rounded-lg">
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!canSave} className="rounded-lg">
              {target === "new" ? (saving ? "Creating…" : "Create") : saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add link
// ---------------------------------------------------------------------------

export function AddLinkDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (id: string) => void;
}) {
  const addLink = useLibraryStore((s) => s.addLink);
  const refreshLink = useLibraryStore((s) => s.refreshLink);
  const items = useLibraryStore((s) => s.items);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setError(null);
    }
  }, [open]);

  const normalized = useMemo(() => {
    const raw = url.trim();
    if (!raw) return null;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(withScheme);
      return u.hostname.includes(".") ? u.toString() : null;
    } catch {
      return null;
    }
  }, [url]);
  const existing = normalized ? items.find((i) => i.kind === "link" && i.url === normalized) : undefined;

  const submit = async () => {
    if (!normalized) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        // A failed refresh is toasted by the store, not thrown: only a fresh
        // fetch counts, so a failure stays open and out of the dataset.
        if (!(await refreshLink(existing.id))) return;
        onAdded?.(existing.id);
      } else {
        const item = await addLink(normalized);
        onAdded?.(item.id);
        useToastStore.getState().push({ kind: "info", title: "Link added", body: item.title });
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a link</DialogTitle>
          <DialogDescription>
            Loach fetches the page once and keeps its text. Refresh it whenever the page changes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-1 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Web address">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
              autoFocus
              inputMode="url"
              spellCheck={false}
            />
          </Field>
          {existing && (
            <p className="text-xs text-foreground/55">
              Already in your Library as “{existing.title}” — adding it again refreshes that copy.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="rounded-lg">
              Cancel
            </Button>
            <Button type="submit" disabled={!normalized || busy} className="gap-1.5 rounded-lg">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Fetching…" : existing ? "Refresh" : "Add link"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dataset name / description
// ---------------------------------------------------------------------------

export function DatasetDialog({
  open,
  onOpenChange,
  datasetId,
  seedItemIds,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this dataset; omit to create one. */
  datasetId?: string | null;
  /** Items the new dataset starts with. */
  seedItemIds?: string[];
  onSaved?: (id: string) => void;
}) {
  const dataset = useLibraryStore((s) =>
    datasetId ? s.datasets.find((d) => d.id === datasetId) : undefined,
  );
  const createDataset = useLibraryStore((s) => s.createDataset);
  const updateDataset = useLibraryStore((s) => s.updateDataset);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(dataset?.name ?? "");
    setDescription(dataset?.description ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (dataset) {
        await updateDataset(dataset.id, name.trim(), description.trim());
        onSaved?.(dataset.id);
      } else {
        const ds = await createDataset(name.trim(), description.trim(), seedItemIds ?? []);
        onSaved?.(ds.id);
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const seeded = seedItemIds?.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{dataset ? "Edit dataset" : "New dataset"}</DialogTitle>
          <DialogDescription>
            {dataset
              ? "Rename it or describe what it's for."
              : seeded > 0
                ? `A named collection starting with the ${seeded} selected item${seeded === 1 ? "" : "s"}. Attach it to a chat or Space in one go.`
                : "A named collection of texts, files and links you can attach to a chat or Space in one go."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-1 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void save(), { ready: !saving && !!name.trim() })}
              placeholder="e.g. Thesis research"
              maxLength={80}
              autoFocus
            />
          </Field>
          <Field label="Description" optional>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void save(), { ready: !saving && !!name.trim() })}
              placeholder="What's in it"
              className="min-h-[80px] rounded-2xl border-foreground/10 bg-foreground/[0.05]"
            />
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="rounded-lg">
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()} className="rounded-lg">
              {dataset ? (saving ? "Saving…" : "Save") : saving ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Item preview (global) — shows exactly what a model would be given.
// ---------------------------------------------------------------------------

export function ItemPreviewDialog() {
  const id = useLibraryStore((s) => s.previewItemId);
  const item = useLibraryStore((s) => (id ? s.items.find((i) => i.id === id) : undefined));
  const datasets = useLibraryStore((s) => s.datasets);
  const openPreview = useLibraryStore((s) => s.openPreview);
  const openTextEditor = useLibraryStore((s) => s.openTextEditor);
  const getContents = useLibraryStore((s) => s.getContents);
  const refreshLink = useLibraryStore((s) => s.refreshLink);
  const rename = useLibraryStore((s) => s.rename);
  const addToDataset = useLibraryStore((s) => s.addToDataset);
  const deleteItems = useDeleteLibraryItems();
  const [full, setFull] = useState<LibraryItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  // Set by Escape, so the blur that follows the field's unmount can't commit
  // the draft it was meant to throw away.
  const renameCancelled = useRef(false);

  useEffect(() => {
    setFull(null);
    setRenaming(false);
    if (!id) return;
    setLoading(true);
    getContents([id])
      .then(([it]) => setFull(it ?? null))
      .finally(() => setLoading(false));
    // `updated_at` re-reads the body after a refresh or an edit.
  }, [id, item?.updated_at, getContents]);

  const close = () => openPreview(null);
  if (!item) {
    return (
      <Dialog open={false}>
        <DialogContent />
      </Dialog>
    );
  }

  const memberOf = datasets.filter((d) => d.item_ids.includes(item.id));
  const others = datasets.filter((d) => !d.item_ids.includes(item.id));
  const when =
    item.kind === "link" && item.fetched_at
      ? `Fetched ${relativeTime(item.fetched_at)}`
      : `Added ${relativeTime(item.created_at)}`;

  const commitRename = async () => {
    if (renameCancelled.current) return;
    const t = draftTitle.trim();
    setRenaming(false);
    if (t && t !== item.title) await rename(item.id, t);
  };

  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex max-h-[86vh] max-w-3xl flex-col gap-0 p-0"
        // Radix hears Escape on the document before the field does, so a
        // rename is cancelled here — otherwise Escape closes the preview.
        onEscapeKeyDown={(e) => {
          if (!renaming) return;
          e.preventDefault();
          renameCancelled.current = true;
          setRenaming(false);
        }}
      >
        <DialogHeader className="border-b border-foreground/[0.07] px-6 pb-4 pt-6 pr-14">
          <div className="flex items-start gap-3">
            <ItemIcon item={item} />
            <div className="min-w-0 flex-1">
              {renaming ? (
                <Input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    // The Enter that confirms an IME candidate isn't the rename's.
                    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                    if (e.key === "Enter") void commitRename();
                  }}
                  autoFocus
                  className="h-8"
                />
              ) : (
                <DialogTitle className="group flex items-center gap-2 text-base leading-snug">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{item.title}</span>
                  <button
                    type="button"
                    aria-label="Rename"
                    onClick={() => {
                      setDraftTitle(item.title);
                      renameCancelled.current = false;
                      setRenaming(true);
                    }}
                    className="rounded-md p-1 text-foreground/40 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </DialogTitle>
              )}
              <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span>{typeLabel(item)}</span>
                <span aria-hidden>·</span>
                <span>{formatBytes(item.size)}</span>
                {item.media === "text" && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{tokensLabel(itemTokens(item))}</span>
                  </>
                )}
                <span aria-hidden>·</span>
                <span title={new Date(item.fetched_at ?? item.created_at).toLocaleString()}>{when}</span>
                <IndexBadge item={item} />
              </DialogDescription>
              {item.url && (
                <button
                  type="button"
                  onClick={() => void openExternal(item.url!)}
                  className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-foreground/55 underline-offset-2 hover:text-foreground hover:underline"
                >
                  <span className="truncate">{item.url}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-[200px] flex-1 overflow-y-auto px-6 py-5">
          {loading && !full ? (
            <div className="flex h-40 items-center justify-center text-foreground/45">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !full ? (
            <p className="text-sm text-foreground/55">Couldn't load this item.</p>
          ) : item.media === "image" ? (
            <img
              src={`data:${safeImageMime(item.mime)};base64,${full.content}`}
              alt={item.title}
              className="mx-auto max-h-[60vh] rounded-xl object-contain"
            />
          ) : item.kind === "text" ? (
            <Markdown content={full.content} className="text-[14px]" />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground/80">
              {full.content}
            </pre>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-foreground/[0.07] px-6 py-3.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {memberOf.map((d) => (
              <span
                key={d.id}
                className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-700 dark:text-violet-300"
              >
                {d.name}
              </span>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-foreground/15 px-2 py-0.5 text-[11px] text-foreground/55 transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  Add to dataset
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 min-w-[200px] overflow-y-auto">
                <DropdownMenuLabel className="text-xs text-foreground/50">Datasets</DropdownMenuLabel>
                {others.length === 0 && (
                  <DropdownMenuItem disabled>
                    {datasets.length === 0 ? "No datasets yet" : "Already in all of them"}
                  </DropdownMenuItem>
                )}
                {others.map((d) => (
                  <DropdownMenuItem key={d.id} onSelect={() => void addToDataset(d.id, [item.id])}>
                    <DatasetIcon size="sm" />
                    <span className="truncate">{d.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-foreground/65 hover:text-destructive"
              onClick={() => void deleteItems([item.id]).then((ok) => ok && close())}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
            {item.kind === "link" && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-lg"
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true);
                  void refreshLink(item.id).finally(() => setRefreshing(false));
                }}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                Refresh
              </Button>
            )}
            {item.kind === "text" && (
              <Button
                size="sm"
                className="gap-1.5 rounded-lg"
                onClick={() => {
                  close();
                  openTextEditor(item.id);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
