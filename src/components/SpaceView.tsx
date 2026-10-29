import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Brain,
  ChevronRight,
  Cpu,
  Layers,
  Library,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ChatInput } from "@/components/ChatInput";
import { ChatLabelDot, ChatLabelSubmenu } from "@/components/ChatLabelMenu";
import { ChatSpaceSubmenu } from "@/components/ChatSpaceMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { DefaultModelPicker, DEFAULT_MODEL_LABEL } from "@/components/DefaultModelPicker";
import { MemoryList } from "@/components/MemoryList";
import { MODE_LABELS } from "@/components/library/ChatSources";
import { SourceModeSwitch, SpaceSourcesTab } from "@/components/library/SpaceSources";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore, type SpaceTab } from "@/stores/spaceStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useToastStore } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";
import { deleteChatConfirm } from "@/lib/confirmations";
import { fileToAttachment } from "@/lib/files";
import { dialogEnter } from "@/lib/shortcuts";
import { spaceSourceCount } from "@/lib/sources";
import { cn, relativeDay } from "@/lib/utils";
import {
  type ChatLabel,
  type ProviderId,
  type RetrievalMode,
  type Session,
  type SpaceFile,
  type SpaceMemory,
} from "@/types";

/** Stable empties for the "not loaded yet" case — a fresh `[]` per render
 *  would churn every memo and effect keyed on these. */
/** Surface a failed chat-row action instead of letting it fall through to
 *  main.tsx's global unhandled-rejection net, which says only "Something
 *  went wrong" with no hint as to which action failed. The store actions
 *  don't catch, so without this every rename / pin / label / archive / delete
 *  in this view shared the vaguest error path in the file. */
function notifyOnFail(p: Promise<unknown>, action: string): void {
  void p.catch((e) => {
    useToastStore.getState().push({
      kind: "error",
      title: `Couldn't ${action}`,
      body: e instanceof Error ? e.message : String(e),
    });
  });
}

const EMPTY_FILES: SpaceFile[] = [];
const EMPTY_MEMORIES: SpaceMemory[] = [];

export function SpaceView() {
  const { confirm } = useConfirm();
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const doUpdate = useSpaceStore((s) => s.updateSpace);
  const doDeleteSpace = useSpaceStore((s) => s.deleteSpace);
  const loadFiles = useSpaceStore((s) => s.loadSpaceFiles);
  const doAddFile = useSpaceStore((s) => s.addFile);
  const doRemoveFile = useSpaceStore((s) => s.removeFile);
  const setRetrievalMode = useSpaceStore((s) => s.setRetrievalMode);
  const storedFiles = useSpaceStore((s) =>
    viewingSpaceId ? s.spaceFiles[viewingSpaceId] : undefined,
  );
  const loadMemories = useSpaceStore((s) => s.loadSpaceMemories);
  const doAddMemory = useSpaceStore((s) => s.addMemory);
  const doUpdateMemory = useSpaceStore((s) => s.updateMemory);
  const doRemoveMemory = useSpaceStore((s) => s.removeMemory);
  const storedMemories = useSpaceStore((s) =>
    viewingSpaceId ? s.spaceMemories[viewingSpaceId] : undefined,
  );

  const sessions = useChatStore((s) => s.sessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const renameChat = useChatStore((s) => s.rename);
  const pinChat = useChatStore((s) => s.pin);
  const setChatLabel = useChatStore((s) => s.setLabel);
  const archiveChat = useChatStore((s) => s.archive);
  const removeChat = useChatStore((s) => s.remove);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);

  const space = spaces.find((s) => s.id === viewingSpaceId);

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // Kept in the store per Space, so a link can open a tab directly (the
  // composer's "Space sources" chip opens Sources) and coming back from one
  // of the Space's chats lands on the tab it was left on.
  const tab = useSpaceStore((s) => (viewingSpaceId ? s.spaceTabs[viewingSpaceId] : undefined)) ?? "chats";
  const setSpaceTab = useSpaceStore((s) => s.setSpaceTab);
  const setTab = (t: SpaceTab) => {
    if (viewingSpaceId) setSpaceTab(viewingSpaceId, t);
  };
  // Read straight from the store rather than mirroring into local state.
  // The mirror only ever copied `stored*` forward, and its effect was
  // guarded on truthiness — so switching to a space whose rows weren't
  // cached yet (`undefined`) left the PREVIOUS space's files, memories and
  // Meta-strip counts on screen until the new load resolved, or forever if
  // it failed.
  const files = storedFiles ?? EMPTY_FILES;
  // Library items / datasets linked to the Space count as sources too —
  // counted the way the composer's "Space sources" chip counts them.
  const libraryLinks = useLibraryStore((s) =>
    viewingSpaceId ? s.sources[`space:${viewingSpaceId}`] : undefined,
  );
  const libraryItems = useLibraryStore((s) => s.items);
  const datasets = useLibraryStore((s) => s.datasets);
  const sourceCount = useMemo(
    () => spaceSourceCount(files, libraryLinks ?? [], datasets, libraryItems),
    [files, libraryLinks, datasets, libraryItems],
  );
  const memories = storedMemories ?? EMPTY_MEMORIES;

  useEffect(() => {
    if (space) {
      void loadFiles(space.id);
      void loadMemories(space.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space?.id]);

  const spaceSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.space_id === viewingSpaceId && !s.archived_at)
        .sort((a, b) => b.updated_at - a.updated_at),
    [sessions, viewingSpaceId],
  );

  if (!space) return null;

  const handleBackToLibrary = () => {
    setViewingSpace(null);
    setSidebarTab("spaces");
  };

  const handleSaveDetails = async (next: { name: string; description: string }) => {
    await doUpdate(space.id, {
      name: next.name,
      description: next.description,
      instructions: space.instructions,
    });
  };

  // The inline tab savers (instructions blur-save, memory toggle, model
  // defaults) fire-and-forget, so route them through this wrapper to surface
  // failures. EditSpaceDialog uses `doUpdate` directly because it renders its
  // own inline error — toasting here too would double up.
  const doUpdateNotify = async (fields: Parameters<typeof doUpdate>[1]) => {
    try {
      await doUpdate(space.id, fields);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save Space",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleDeleteSpace = async () => {
    const ok = await confirm({
      title: `Delete Space “${space.name}”?`,
      body: "Its instructions, memories and uploaded files are deleted for good. Library sources stay in your Library, and its chats are kept outside any Space.",
      confirmLabel: "Delete Space",
      destructive: true,
    });
    if (ok) {
      void doDeleteSpace(space.id).then((deleted) => {
        if (deleted) {
          // Stop viewing the now-deleted space first — App routes on
          // `viewingSpaceId` before the sidebar tab, so without this SpaceView
          // stays mounted and renders null for the missing space (blank canvas).
          setViewingSpace(null);
          setSidebarTab("spaces");
        }
      });
    }
  };

  const openChat = (sessionId: string) => {
    setViewingSpace(null);
    setSidebarTab("chats");
    void selectSession(sessionId);
  };

  // Meta strip — surfaces glanceable counts so we can keep the tab labels
  // clean. Each segment hides itself when it would be uninformative (zero
  // files, no instructions). Chat count and model are always shown so the
  // user can read the space's posture even when most knobs are at default.
  const hasInstructions = space.instructions.trim().length > 0;
  // The whole model id, as a snippet card shows a pinned model.
  const pinnedModel = space.default_model && space.default_provider ? space.default_model : null;

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        {/* Page wrapper carries no horizontal padding — children that need
            indentation handle their own. This way the title column and the
            ChatInput's visual prompt bar (which has its own internal
            padding) end up the exact same width. */}
        <div className="mx-auto w-full max-w-3xl pb-12 pt-8">
          {/* Title-area block — inset to match the prompt's internal padding. */}
          <div className="px-4">
          {/* Breadcrumb */}
          <button
            onClick={handleBackToLibrary}
            className="mb-6 inline-flex items-center gap-1.5 text-xs text-foreground/45 transition-colors hover:text-foreground/75"
          >
            <span>Spaces</span>
            <ChevronRight className="h-3 w-3" />
            <span className="text-foreground/55">{space.name}</span>
          </button>

          {/* Title row */}
          <div className="flex items-center gap-3">
            <Layers className="h-7 w-7 shrink-0 text-foreground/65" strokeWidth={1.75} />
            <h1 className="flex-1 truncate text-3xl font-semibold tracking-tight text-foreground">
              {space.name}
            </h1>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Space actions"
                  className="rounded-xl text-foreground/55 hover:bg-foreground/10 hover:text-foreground"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onSelect={() => setEditDialogOpen(true)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit details
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={handleDeleteSpace}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Space
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Description */}
          <div className="mt-1.5 ml-10">
            <p
              className={cn(
                "text-sm",
                space.description
                  ? "text-foreground/55"
                  : "italic text-foreground/30",
              )}
            >
              {space.description || "No description"}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <MetaChip>
                {spaceSessions.length}{" "}
                {spaceSessions.length === 1 ? "chat" : "chats"}
              </MetaChip>
              {sourceCount > 0 && (
                <MetaChip>
                  {sourceCount} {sourceCount === 1 ? "source" : "sources"}
                </MetaChip>
              )}
              {hasInstructions && <MetaChip>Instructions on</MetaChip>}
              {memories.length > 0 && (
                <MetaChip>
                  {memories.length}{" "}
                  {memories.length === 1 ? "memory" : "memories"}
                </MetaChip>
              )}
              <MetaChip>
                {pinnedModel ? (
                  <span
                    className="block max-w-[24ch] truncate"
                    title={`${space.default_provider} · ${pinnedModel}`}
                  >
                    {pinnedModel}
                  </span>
                ) : (
                  DEFAULT_MODEL_LABEL
                )}
              </MetaChip>
            </div>
          </div>
          </div>
          {/* /title-area */}

          {/* Prompt panel — placed outside the inset wrapper so its visual
              prompt bar lines up edge-to-edge with the title above. */}
          <div className="mt-8">
            <ChatInput centered />
          </div>

          {/* Tabs — re-inset to match the title column. */}
          <div className="mt-10 px-4">
            <Tabs value={tab} onValueChange={(v) => setTab(v as SpaceTab)}>
              {/* Centered, auto-width — TabsList default is `inline-flex`,
                  so wrapping in a flex container is enough to centre it
                  without stretching. */}
              <div className="flex justify-center">
                <TabsList>
                  <TabsTrigger value="chats">Chats</TabsTrigger>
                  <TabsTrigger value="instructions">Instructions</TabsTrigger>
                  <TabsTrigger value="files">Sources</TabsTrigger>
                  <TabsTrigger value="memory">Memory</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="chats" className="mt-6">
                <ChatsTab
                  sessions={spaceSessions}
                  onOpen={openChat}
                  onRename={(id, title) => notifyOnFail(renameChat(id, title), "rename this chat")}
                  onPin={(id, pinned) => notifyOnFail(pinChat(id, pinned), "pin this chat")}
                  onSetLabel={(id, label) => notifyOnFail(setChatLabel(id, label), "label this chat")}
                  onArchive={(id) => notifyOnFail(archiveChat(id, true), "archive this chat")}
                  onDelete={(id) => notifyOnFail(removeChat(id), "delete this chat")}
                />
              </TabsContent>

              <TabsContent value="instructions" className="mt-6">
                <InstructionsTab
                  space={space}
                  onSave={(instructions) =>
                    doUpdateNotify({
                      name: space.name,
                      description: space.description,
                      instructions,
                    })
                  }
                />
              </TabsContent>

              <TabsContent value="files" className="mt-6">
                <SpaceSourcesTab
                  space={space}
                  files={files}
                  onUpload={async (fileList) => {
                    for (const f of Array.from(fileList)) {
                      const att = await fileToAttachment(f);
                      await doAddFile(
                        space.id,
                        att.name,
                        att.mime,
                        att.kind,
                        att.data,
                        f.size,
                      );
                    }
                  }}
                  onRemoveFile={async (id) => {
                    // An upload lives only in this Space, so removing it is a
                    // delete — unlike unlinking a Library source.
                    const f = files.find((x) => x.id === id);
                    const ok = await confirm({
                      title: `Delete “${f?.name ?? "this file"}”?`,
                      body:
                        "Uploads are stored only in this Space, so it will be gone for good." +
                        (f && f.kind !== "file" ? " Save it to your Library first to keep a copy." : ""),
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) void doRemoveFile(id, space.id);
                  }}
                />
              </TabsContent>

              <TabsContent value="memory" className="mt-6">
                <MemoryTab
                  space={space}
                  memories={memories}
                  onOpenSettings={() => setTab("settings")}
                  onAdd={(content) =>
                    doAddMemory({ space_id: space.id, content }).catch((e) => {
                      useToastStore.getState().push({
                        kind: "error",
                        title: "Couldn't add memory",
                        body: e instanceof Error ? e.message : String(e),
                      });
                      // Rethrow so MemoryTab keeps the typed draft instead
                      // of clearing it as if the add had landed.
                      throw e;
                    })
                  }
                  onUpdate={(id, content) =>
                    doUpdateMemory(id, space.id, content).catch((e) => {
                      useToastStore.getState().push({
                        kind: "error",
                        title: "Couldn't update memory",
                        body: e instanceof Error ? e.message : String(e),
                      });
                      // Rethrow so MemoryTab stays in edit mode with the
                      // draft intact rather than discarding the edit.
                      throw e;
                    })
                  }
                  onRemove={(id) =>
                    doRemoveMemory(id, space.id).catch((e) => {
                      useToastStore.getState().push({
                        kind: "error",
                        title: "Couldn't remove memory",
                        body: e instanceof Error ? e.message : String(e),
                      });
                    })
                  }
                  onOpenChat={openChat}
                />
              </TabsContent>

              <TabsContent value="settings" className="mt-6">
                <SettingsTab
                  space={space}
                  onSave={(patch) =>
                    doUpdateNotify({
                      name: space.name,
                      description: space.description,
                      instructions: space.instructions,
                      ...patch,
                    })
                  }
                  onSetMode={(mode) => void setRetrievalMode(space.id, mode)}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </ScrollArea>

      <EditSpaceDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        initialName={space.name}
        initialDescription={space.description}
        onSave={handleSaveDetails}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Edit details dialog — mirrors the create-space form so the two affordances
// feel identical from the user's seat.
// ---------------------------------------------------------------------------

function EditSpaceDialog({
  open,
  onOpenChange,
  initialName,
  initialDescription,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  initialDescription: string;
  onSave: (next: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseed when the dialog opens so a stale draft from a prior open doesn't
  // leak across edits, and so navigating to a different space picks up its
  // current values.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescription(initialDescription);
      setError(null);
    }
  }, [open, initialName, initialDescription]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    // Compare trimmed-vs-trimmed so an unchanged dialog whose stored values
    // carry incidental whitespace still short-circuits instead of firing a
    // redundant save.
    if (
      trimmedName === initialName.trim() &&
      trimmedDesc === initialDescription.trim()
    ) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmedName, description: trimmedDesc });
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Space</DialogTitle>
          <DialogDescription>
            Update the name and description for this Space.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <Field label="Name">
            <Input
              id="edit-space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void handleSave(), { ready: !saving && !!name.trim() })}
              placeholder="e.g. Website redesign"
              maxLength={60}
              autoFocus
            />
          </Field>
          <Field label="Description" optional>
            <Textarea
              id="edit-space-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void handleSave(), { ready: !saving && !!name.trim() })}
              placeholder="Describe your project, goals, subject…"
              className="min-h-[88px] rounded-2xl border-foreground/10 bg-foreground/[0.05]"
            />
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-lg"
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="rounded-lg"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Chats tab
// ---------------------------------------------------------------------------

interface ChatsTabProps {
  sessions: Session[];
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onSetLabel: (id: string, label: ChatLabel | null) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

function ChatsTab({
  sessions,
  onOpen,
  onRename,
  onPin,
  onSetLabel,
  onArchive,
  onDelete,
}: ChatsTabProps) {
  const { confirm } = useConfirm();
  // Inline rename — single id at a time so blurring one row to start
  // editing another doesn't leave a stale draft anywhere.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-foreground/10 px-6 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-foreground/35" />
        <p className="text-sm text-foreground/55">
          No chats yet — type above to start the first one in this Space.
        </p>
      </div>
    );
  }

  // Group by relativeDay bucket so we don't lean on absolute timestamps
  // for casual scanning.
  const buckets: Record<
    "today" | "yesterday" | "week" | "older",
    Session[]
  > = { today: [], yesterday: [], week: [], older: [] };
  for (const s of sessions) buckets[relativeDay(s.updated_at)].push(s);

  const groups: { label: string; rows: Session[] }[] = [
    { label: "Today", rows: buckets.today },
    { label: "Yesterday", rows: buckets.yesterday },
    { label: "This week", rows: buckets.week },
    { label: "Older", rows: buckets.older },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <div key={g.label}>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-foreground/40">
            {g.label}
          </h3>
          <ul className="space-y-1">
            {g.rows.map((s) => (
              <ChatRow
                key={s.id}
                session={s}
                renaming={renamingId === s.id}
                onStartRename={() => setRenamingId(s.id)}
                onCommitRename={(title) => {
                  setRenamingId(null);
                  const next = title.trim();
                  if (next && next !== s.title) onRename(s.id, next);
                }}
                onCancelRename={() => setRenamingId(null)}
                onOpen={() => onOpen(s.id)}
                onPin={() => onPin(s.id, !s.pinned_at)}
                onSetLabel={(label) => onSetLabel(s.id, label)}
                onArchive={() => onArchive(s.id)}
                onDelete={async () => {
                  const ok = await confirm(deleteChatConfirm(s.title));
                  if (ok) onDelete(s.id);
                }}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single chat row — inline rename + right-click context menu
// ---------------------------------------------------------------------------

interface ChatRowProps {
  session: Session;
  renaming: boolean;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onPin: () => void;
  onSetLabel: (label: ChatLabel | null) => void;
  onArchive: () => void;
  onDelete: () => void;
}

function ChatRow({
  session,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onOpen,
  onPin,
  onSetLabel,
  onArchive,
  onDelete,
}: ChatRowProps) {
  const [draft, setDraft] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);

  // Reseed the draft when a fresh rename starts so the input opens with the
  // current title rather than a stale one from a previous edit.
  useEffect(() => {
    if (renaming) setDraft(session.title);
  }, [renaming, session.title]);

  if (renaming) {
    return (
      <li>
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitRename(draft)}
          onKeyDown={(e) => {
            // The Enter that confirms an IME candidate isn't the rename's.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          className="h-9 rounded-xl border-foreground/10 bg-foreground/[0.04] px-3 text-sm"
        />
      </li>
    );
  }

  return (
    <li>
      {/* The row itself doesn't host the DropdownMenu's anchor — we use a
          hidden trigger button positioned at the row's right edge so the
          menu pops up in a predictable place regardless of where on the
          row the user actually right-clicked. Mirrors the Sidebar row's
          pattern; keeps the row's primary onClick (open chat) intact. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          // Only the row's own keys: Enter on its ⋯ button (or a menu item,
          // which bubbles here through the portal) belongs to that control —
          // a keyboard Delete or Rename used to open the chat as well.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        className="group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none"
      >
        <ChatLabelDot label={session.label} />
        <MessageSquare className="h-4 w-4 shrink-0 text-foreground/40 group-hover:text-foreground/65" />
        <span className="min-w-0 flex-1 truncate text-foreground/80 group-hover:text-foreground">
          {session.title || "Untitled"}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px] text-foreground/35 transition-opacity",
            menuOpen ? "opacity-0" : "opacity-100 group-hover:opacity-0",
          )}
        >
          {trimModelLabel(session.model)}
        </span>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Chat actions"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground/55 transition-opacity hover:bg-foreground/10 hover:text-foreground",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
            className="min-w-[200px]"
          >
            <DropdownMenuItem onSelect={onPin}>
              {session.pinned_at ? (
                <>
                  <PinOff className="mr-2 h-4 w-4" />
                  Unpin
                </>
              ) : (
                <>
                  <Pin className="mr-2 h-4 w-4" />
                  Pin this chat
                </>
              )}
            </DropdownMenuItem>
            <ChatLabelSubmenu
              value={session.label}
              onSelect={onSetLabel}
              iconClassName="mr-2 h-4 w-4"
            />
            <ChatSpaceSubmenu session={session} iconClassName="mr-2 h-4 w-4" />
            <DropdownMenuItem onSelect={onStartRename}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onArchive}>
              <Archive className="mr-2 h-4 w-4" />
              Move to archive
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Instructions tab
// ---------------------------------------------------------------------------

function InstructionsTab({
  space,
  onSave,
}: {
  space: { id: string; instructions: string };
  onSave: (instructions: string) => Promise<void>;
}) {
  const [val, setVal] = useState(space.instructions);
  useEffect(() => {
    setVal(space.instructions);
  }, [space.id, space.instructions]);

  const dirty = val !== space.instructions;

  // Saved on blur, and again when the tab goes away with edits the blur never
  // caught — a keyboard shortcut or the app lock leaves without blurring the
  // field. `sent` keeps a blur followed straight by an unmount (clicking
  // another tab) from saving the same text twice.
  const sent = useRef<string | null>(null);
  const save = (text: string) => {
    sent.current = text;
    void onSave(text.trim());
  };
  const latest = useRef({ val, dirty, save });
  useEffect(() => {
    latest.current = { val, dirty, save };
  });
  useEffect(
    () => () => {
      const l = latest.current;
      if (l.dirty && l.val !== sent.current) l.save(l.val);
    },
    [space.id],
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground/55">
        Sent as the system prompt for every chat in this Space. Replaces your
        global system prompt while a chat lives here.
      </p>
      <Textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          if (dirty) save(val);
        }}
        placeholder="e.g. Reply concisely and in the voice of a senior engineer reviewing a PR."
        className="min-h-[200px] rounded-xl border-foreground/10 bg-foreground/[0.03] text-sm leading-relaxed"
      />
      <div className="flex items-center justify-between text-[11px] text-foreground/40">
        <span>{val.length.toLocaleString()} characters</span>
        {dirty && <span className="text-foreground/55">Saves when you click away</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
//
// Everything that sets how the Space's chats behave, in one place: the default
// model, memory auto-save and how sources reach the model. They used to be
// spread over a Models tab holding a single dropdown, a switch above the
// Memory list and a selector on the Sources tab; those two tabs now show the
// setting as a status line linking back here.

interface SettingsPatch {
  default_provider?: string | null;
  default_model?: string | null;
  memory_enabled?: boolean | null;
}

function SettingsTab({
  space,
  onSave,
  onSetMode,
}: {
  space: {
    default_provider: ProviderId | null;
    default_model: string | null;
    memory_enabled: boolean;
    retrieval_mode: RetrievalMode;
  };
  onSave: (patch: SettingsPatch) => Promise<void>;
  onSetMode: (mode: RetrievalMode) => void;
}) {
  return (
    <div className="space-y-4">
      <SettingCard
        icon={<Cpu className="h-4 w-4 text-foreground/55" />}
        title="Default model"
        description="Used by every chat created in this Space. Leave it on Default model to use your General Settings default; a model picked in a chat still wins for that chat."
      >
        <DefaultModelPicker
          provider={space.default_provider}
          model={space.default_model}
          onChange={(provider, model) => void onSave({ default_provider: provider, default_model: model })}
        />
      </SettingCard>

      <SettingCard
        icon={<Brain className="h-4 w-4 text-foreground/55" />}
        title="Memory"
        description={'Auto-saves durable facts from your chats so the assistant remembers them next time. New memories trigger a "Saved to memory" toast. Existing memories stay in the prompt even when this is off.'}
        control={
          <Switch
            checked={space.memory_enabled}
            onCheckedChange={(v) => void onSave({ memory_enabled: !!v })}
            aria-label="Save memories automatically"
          />
        }
      />

      <SettingCard
        icon={<Library className="h-4 w-4 text-foreground/55" />}
        title="How sources reach the model"
        description={MODE_LABELS[space.retrieval_mode].hint}
        control={<SourceModeSwitch value={space.retrieval_mode} onChange={onSetMode} />}
      />
    </div>
  );
}

/** One setting on the Settings tab: a title and what it does, with its
 *  control beside them (a switch) or below them (the model picker). */
function SettingCard({
  icon,
  title,
  description,
  control,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground/85">
            {icon}
            {title}
          </div>
          <p className="mt-1 text-xs text-foreground/55">{description}</p>
        </div>
        {control}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory tab
// ---------------------------------------------------------------------------
//
// Surfaces the per-space memory the extractor accumulates, with whether
// auto-save is on — switched on the Settings tab. The list itself (add /
// inline edit / delete / search / source link) is the shared `MemoryList`,
// also used for global memories.

function MemoryTab({
  space,
  memories,
  onOpenSettings,
  onAdd,
  onUpdate,
  onRemove,
  onOpenChat,
}: {
  space: { id: string; memory_enabled: boolean };
  memories: SpaceMemory[];
  onOpenSettings: () => void;
  onAdd: (content: string) => Promise<unknown>;
  onUpdate: (id: string, content: string) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onOpenChat: (sessionId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-foreground/65">
          <Brain className="h-4 w-4 shrink-0 text-foreground/55" />
          {space.memory_enabled
            ? "Auto-save is on: new facts from this Space's chats are saved here."
            : "Auto-save is off: these memories still reach the model, but nothing new is saved."}
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          className="shrink-0 text-foreground/55 underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Change in Settings
        </button>
      </div>

      <MemoryList
        memories={memories}
        enabled={space.memory_enabled}
        emptyText={
          space.memory_enabled
            ? "No memories yet — chat in this Space and the extractor will start saving durable facts here."
            : "Memory is off for this Space. Turn it on in Settings to start collecting facts."
        }
        onAdd={onAdd}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onOpenChat={onOpenChat}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Small pill used in the meta strip under the title. Pulled out as its own
 * component so every chip shares the same surface tokens — bumping the
 * styling here updates all of them in lockstep.
 */
function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-foreground/70">
      {children}
    </span>
  );
}

// Drop the `:tag` suffix on Ollama model ids (`llama3.1:8b` → `llama3.1`)
// for compact display in chat-row meta. Falls through for
// OpenAI-style ids (no colon).
function trimModelLabel(id: string): string {
  if (!id) return "";
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : id;
}
