import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileText,
  Folder,
  Image as ImageIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ChatInput } from "@/components/ChatInput";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { fileToAttachment } from "@/lib/files";
import {
  ollamaListModels,
  ollamaProbe,
  openaiListModels,
} from "@/lib/tauri";
import { cn, relativeDay } from "@/lib/utils";
import {
  type ModelInfo,
  type ProviderId,
  type Session,
  type SpaceFile,
  type SpaceMemory,
} from "@/types";

type TabId = "chats" | "instructions" | "files" | "memory" | "models";

const FILE_CAP = 12;

export function SpaceView() {
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const doUpdate = useSpaceStore((s) => s.updateSpace);
  const doDeleteSpace = useSpaceStore((s) => s.deleteSpace);
  const loadFiles = useSpaceStore((s) => s.loadSpaceFiles);
  const doAddFile = useSpaceStore((s) => s.addFile);
  const doRemoveFile = useSpaceStore((s) => s.removeFile);
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
  const archiveChat = useChatStore((s) => s.archive);
  const removeChat = useChatStore((s) => s.remove);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);

  const space = spaces.find((s) => s.id === viewingSpaceId);

  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descVal, setDescVal] = useState("");
  const [tab, setTab] = useState<TabId>("chats");
  const [files, setFiles] = useState<SpaceFile[]>([]);
  const [memories, setMemories] = useState<SpaceMemory[]>([]);

  // Reseed the local edit state when the user navigates between spaces.
  // Deliberately keyed on `space?.id` only — re-running on every Space
  // mutation would clobber an in-progress inline edit when the optimistic
  // update lands.
  useEffect(() => {
    if (space) {
      setNameVal(space.name);
      setDescVal(space.description);
      void loadFiles(space.id);
      void loadMemories(space.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space?.id]);

  useEffect(() => {
    if (storedFiles) setFiles(storedFiles);
  }, [storedFiles]);

  useEffect(() => {
    if (storedMemories) setMemories(storedMemories);
  }, [storedMemories]);

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

  const handleSaveName = async () => {
    const trimmed = nameVal.trim();
    if (trimmed && trimmed !== space.name) {
      await doUpdate(space.id, {
        name: trimmed,
        description: space.description,
        instructions: space.instructions,
      });
    } else {
      setNameVal(space.name);
    }
    setEditingName(false);
  };

  const handleSaveDesc = async () => {
    const next = descVal.trim();
    if (next !== space.description) {
      await doUpdate(space.id, {
        name: space.name,
        description: next,
        instructions: space.instructions,
      });
    }
    setEditingDesc(false);
  };

  const handleDeleteSpace = () => {
    if (
      confirm(
        `Delete space "${space.name}"? Files and instructions will be removed; chats inside this space stay but lose their space association.`,
      )
    ) {
      void doDeleteSpace(space.id).then(() => {
        setSidebarTab("spaces");
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
  const modelLabel =
    space.default_model && space.default_provider
      ? trimModelLabel(space.default_model)
      : "Default model";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
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
            <Folder className="h-7 w-7 shrink-0 text-foreground/65" strokeWidth={1.75} />
            {editingName ? (
              <Input
                autoFocus
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onBlur={() => void handleSaveName()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setNameVal(space.name);
                    setEditingName(false);
                  }
                }}
                className="h-auto flex-1 border-none bg-transparent p-0 text-3xl font-semibold tracking-tight focus-visible:ring-0"
              />
            ) : (
              <h1
                className="flex-1 cursor-pointer truncate text-3xl font-semibold tracking-tight text-foreground transition-colors hover:text-foreground/85"
                onClick={() => setEditingName(true)}
                title="Click to rename"
              >
                {space.name}
              </h1>
            )}

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
                <DropdownMenuItem
                  onSelect={handleDeleteSpace}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete space
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Description */}
          <div className="mt-1.5 ml-10">
            {editingDesc ? (
              <Input
                autoFocus
                value={descVal}
                onChange={(e) => setDescVal(e.target.value)}
                onBlur={() => void handleSaveDesc()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setDescVal(space.description);
                    setEditingDesc(false);
                  }
                }}
                placeholder="Add a description"
                className="h-auto border-none bg-transparent p-0 text-sm text-foreground/55 focus-visible:ring-0"
              />
            ) : (
              <p
                className={cn(
                  "cursor-pointer text-sm transition-colors",
                  space.description
                    ? "text-foreground/55 hover:text-foreground/75"
                    : "italic text-foreground/30 hover:text-foreground/50",
                )}
                onClick={() => setEditingDesc(true)}
                title="Click to edit"
              >
                {space.description || "Add a description"}
              </p>
            )}

            {/* Meta strip — surfaces the same counts that used to live as
                tab badges, but as small chips so they sit comfortably under
                the description and stay readable on the page background.
                Each chip hides itself when it would be uninformative. The
                file chip drops the cap (`/12`) — the limit only matters
                when the user is actively adding files, and the Files tab
                already shows it. */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <MetaChip>
                {spaceSessions.length}{" "}
                {spaceSessions.length === 1 ? "chat" : "chats"}
              </MetaChip>
              {files.length > 0 && (
                <MetaChip>
                  {files.length} {files.length === 1 ? "file" : "files"}
                </MetaChip>
              )}
              {hasInstructions && <MetaChip>Instructions on</MetaChip>}
              {memories.length > 0 && (
                <MetaChip>
                  {memories.length}{" "}
                  {memories.length === 1 ? "memory" : "memories"}
                </MetaChip>
              )}
              <MetaChip>{modelLabel}</MetaChip>
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
            <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
              {/* Centered, auto-width — TabsList default is `inline-flex`,
                  so wrapping in a flex container is enough to centre it
                  without stretching. */}
              <div className="flex justify-center">
                <TabsList>
                  <TabsTrigger value="chats">Chats</TabsTrigger>
                  <TabsTrigger value="instructions">Instructions</TabsTrigger>
                  <TabsTrigger value="files">Files</TabsTrigger>
                  <TabsTrigger value="memory">Memory</TabsTrigger>
                  <TabsTrigger value="models">Models</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="chats" className="mt-6">
                <ChatsTab
                  sessions={spaceSessions}
                  onOpen={openChat}
                  onRename={(id, title) => void renameChat(id, title)}
                  onPin={(id, pinned) => void pinChat(id, pinned)}
                  onArchive={(id) => void archiveChat(id, true)}
                  onDelete={(id) => void removeChat(id)}
                />
              </TabsContent>

              <TabsContent value="instructions" className="mt-6">
                <InstructionsTab
                  space={space}
                  onSave={(instructions) =>
                    doUpdate(space.id, {
                      name: space.name,
                      description: space.description,
                      instructions,
                    })
                  }
                />
              </TabsContent>

              <TabsContent value="files" className="mt-6">
                <FilesTab
                  files={files}
                  onAdd={async (fileList) => {
                    for (const f of Array.from(fileList)) {
                      if (files.length >= FILE_CAP) return;
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
                  onRemove={(id) => void doRemoveFile(id, space.id)}
                />
              </TabsContent>

              <TabsContent value="memory" className="mt-6">
                <MemoryTab
                  space={space}
                  memories={memories}
                  onToggle={(enabled) =>
                    doUpdate(space.id, {
                      name: space.name,
                      description: space.description,
                      instructions: space.instructions,
                      memory_enabled: enabled,
                    })
                  }
                  onAdd={(content) =>
                    doAddMemory({ space_id: space.id, content })
                  }
                  onUpdate={(id, content) =>
                    doUpdateMemory(id, space.id, content)
                  }
                  onRemove={(id) => doRemoveMemory(id, space.id)}
                />
              </TabsContent>

              <TabsContent value="models" className="mt-6">
                <ModelsTab
                  space={space}
                  onSave={(patch) =>
                    doUpdate(space.id, {
                      name: space.name,
                      description: space.description,
                      instructions: space.instructions,
                      ...patch,
                    })
                  }
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </ScrollArea>
    </div>
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
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

function ChatsTab({
  sessions,
  onOpen,
  onRename,
  onPin,
  onArchive,
  onDelete,
}: ChatsTabProps) {
  // Inline rename — single id at a time so blurring one row to start
  // editing another doesn't leave a stale draft anywhere.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-foreground/10 px-6 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-foreground/35" />
        <p className="text-sm text-foreground/55">
          No chats yet — type above to start the first one in this space.
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
    { label: "Earlier this week", rows: buckets.week },
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
                onArchive={() => onArchive(s.id)}
                onDelete={() => {
                  if (
                    confirm(
                      `Delete this chat (${s.title || "Untitled"})? This cannot be undone — all messages and metrics will be removed.`,
                    )
                  ) {
                    onDelete(s.id);
                  }
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
        <MessageSquare className="h-4 w-4 shrink-0 text-foreground/40 group-hover:text-foreground/65" />
        <span className="min-w-0 flex-1 truncate text-foreground/80 group-hover:text-foreground">
          {session.title || "Untitled"}
        </span>
        <span className="shrink-0 text-[11px] text-foreground/35">
          {trimModelLabel(session.model)}
        </span>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none absolute right-2 top-1/2 h-0 w-0 -translate-y-1/2"
            />
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

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground/55">
        Sent as the system prompt for every chat in this space. Replaces your
        global system prompt while a chat lives here.
      </p>
      <Textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          if (dirty) void onSave(val.trim());
        }}
        placeholder="e.g. Reply concisely and in the voice of a senior engineer reviewing a PR."
        className="min-h-[200px] rounded-xl border-foreground/10 bg-foreground/[0.03] text-sm leading-relaxed"
      />
      <div className="flex items-center justify-between text-[11px] text-foreground/40">
        <span>{val.length.toLocaleString()} characters</span>
        {dirty && <span className="text-foreground/55">Unsaved — blur to save</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files tab
// ---------------------------------------------------------------------------

function FilesTab({
  files,
  onAdd,
  onRemove,
}: {
  files: SpaceFile[];
  onAdd: (files: FileList) => Promise<void>;
  onRemove: (fileId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const remaining = FILE_CAP - files.length;
  const atCap = remaining <= 0;

  const handlePick = async (list: FileList) => {
    setError(null);
    setBusy(true);
    try {
      await onAdd(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground/55">
        Reference files available to every chat in this space. Text files are
        inlined into the system prompt; images attach to vision-capable
        models. 15&nbsp;MB per file.
      </p>

      {/* Upload row */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm text-foreground/55">
          <Upload className="h-4 w-4" />
          <span>
            {atCap
              ? `Reached the ${FILE_CAP}-file limit`
              : `${files.length} of ${FILE_CAP} files · ${formatSize(totalBytes)}`}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={atCap || busy}
          className="rounded-lg"
        >
          <Plus className="h-3.5 w-3.5" />
          Add file
        </Button>
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

      {files.length > 0 && (
        <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.02]">
          {files.map((f) => (
            <li
              key={f.id}
              className="group flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-foreground/[0.04]"
            >
              {f.kind === "image" ? (
                <ImageIcon className="h-4 w-4 shrink-0 text-foreground/45" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-foreground/45" />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {f.name}
              </span>
              <span className="shrink-0 text-[11px] text-foreground/40">
                {formatSize(f.size)}
              </span>
              <button
                onClick={() => onRemove(f.id)}
                aria-label={`Remove ${f.name}`}
                className="shrink-0 rounded-md p-1 text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models tab
// ---------------------------------------------------------------------------

interface ModelsPatch {
  default_provider?: string | null;
  default_model?: string | null;
  default_params_json?: string | null;
}

function ModelsTab({
  space,
  onSave,
}: {
  space: {
    default_provider: ProviderId | null;
    default_model: string | null;
    default_params_json: string | null;
  };
  onSave: (patch: ModelsPatch) => Promise<void>;
}) {
  const settings = useSettingsStore();
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [openaiModels, setOpenaiModels] = useState<ModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const probe = await ollamaProbe(settings.ollama_base_url).catch(
          () => false,
        );
        setOllamaUp(probe);
        if (probe) {
          const m = await ollamaListModels(settings.ollama_base_url).catch(
            () => [],
          );
          setOllamaModels(m);
        } else {
          setOllamaModels([]);
        }
        if (settings.openai_key_set) {
          const m = await openaiListModels(settings.openai_base_url).catch(
            () => [],
          );
          setOpenaiModels(m);
        }
      } finally {
        setLoading(false);
      }
    },
    [
      settings.ollama_base_url,
      settings.openai_base_url,
      settings.openai_key_set,
    ],
  );

  useEffect(() => {
    if (!settings.hydrated) return;
    refresh();
  }, [settings.hydrated, refresh]);

  const hasPick = !!(space.default_model && space.default_provider);

  const pickModel = (provider: ProviderId | null, model: string | null) => {
    void onSave({ default_provider: provider, default_model: model });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground/55">
        Pick a default model for every chat created in this space. Leave
        blank to inherit your General Settings default; per-chat picks
        still win once a chat is open.
      </p>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-11 w-full justify-between gap-2 rounded-xl border-foreground/10 bg-foreground/[0.02] px-4 text-left font-normal hover:bg-foreground/[0.05]"
          >
            {hasPick ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-foreground/90">
                  {space.default_model}
                </span>
                <span className="shrink-0 text-[11px] text-foreground/40">
                  {space.default_provider}
                </span>
              </span>
            ) : (
              <span className="text-foreground/40">Select a model</span>
            )}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[--radix-dropdown-menu-trigger-width]"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <DropdownMenuLabel className="p-0">Default model</DropdownMenuLabel>
            <button
              onClick={(e) => {
                e.preventDefault();
                refresh();
              }}
              className="rounded p-1 hover:bg-accent"
              aria-label="Refresh models"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>
          {hasPick && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => pickModel(null, null)}>
                Clear selection
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-1.5">
            {ollamaUp ? (
              <CircleCheck className="h-3 w-3 text-emerald-500" />
            ) : (
              <CircleAlert className="h-3 w-3 text-amber-500" />
            )}
            Ollama
          </DropdownMenuLabel>
          {ollamaModels.length === 0 && (
            <DropdownMenuItem disabled>
              {ollamaUp ? "No models installed" : "Not running"}
            </DropdownMenuItem>
          )}
          {ollamaModels.map((m) => (
            <DropdownMenuItem
              key={`ollama:${m.id}`}
              onSelect={() => pickModel("ollama", m.id)}
              className={cn(
                space.default_provider === "ollama" &&
                  space.default_model === m.id &&
                  "bg-foreground/[0.06]",
              )}
            >
              {m.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>OpenAI</DropdownMenuLabel>
          {openaiModels.length === 0 && (
            <DropdownMenuItem disabled>
              {settings.openai_key_set ? "No models" : "API key not set"}
            </DropdownMenuItem>
          )}
          {openaiModels.slice(0, 30).map((m) => (
            <DropdownMenuItem
              key={`openai:${m.id}`}
              onSelect={() => pickModel("openai", m.id)}
              className={cn(
                space.default_provider === "openai" &&
                  space.default_model === m.id &&
                  "bg-foreground/[0.06]",
              )}
            >
              {m.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory tab
// ---------------------------------------------------------------------------
//
// Surfaces the per-space memory the extractor accumulates plus the on/off
// toggle. Edits are inline and commit on blur (same pattern as the
// description field above). Manual "Add memory" lets users seed facts the
// extractor hasn't picked up yet.

function MemoryTab({
  space,
  memories,
  onToggle,
  onAdd,
  onUpdate,
  onRemove,
}: {
  space: { id: string; memory_enabled: boolean };
  memories: SpaceMemory[];
  onToggle: (enabled: boolean) => Promise<void>;
  onAdd: (content: string) => Promise<unknown>;
  onUpdate: (id: string, content: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await onAdd(trimmed);
      setDraft("");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (m: SpaceMemory) => {
    setEditingId(m.id);
    setEditVal(m.content);
  };

  const commitEdit = async () => {
    if (!editingId) return;
    const trimmed = editVal.trim();
    const original = memories.find((m) => m.id === editingId);
    if (trimmed && original && trimmed !== original.content) {
      await onUpdate(editingId, trimmed);
    }
    setEditingId(null);
    setEditVal("");
  };

  return (
    <div className="space-y-4">
      {/* Toggle row — mirrors the on/off chip from the meta strip with a
          short rationale so users know exactly what flipping it does. */}
      <div className="flex items-start justify-between gap-4 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground/85">
            <Brain className="h-4 w-4 text-foreground/55" />
            Memory
          </div>
          <p className="mt-1 text-xs text-foreground/55">
            Auto-saves durable facts from your chats so the assistant remembers
            them next time. New memories trigger a "Saved to memory" toast.
            Existing memories stay in the prompt even when this is off.
          </p>
        </div>
        <Switch
          checked={space.memory_enabled}
          onCheckedChange={(v) => void onToggle(!!v)}
        />
      </div>

      {/* Manual add — gated behind the same toggle so a disabled space
          doesn't accumulate new rows from any path. */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground/65">
          Add a memory
        </label>
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Prefers TypeScript over JavaScript."
            disabled={!space.memory_enabled || adding}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleAdd();
              }
            }}
            className="h-10 flex-1 rounded-xl border-foreground/10 bg-foreground/[0.03]"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!space.memory_enabled || adding || !draft.trim()}
            onClick={() => void handleAdd()}
            className="rounded-xl"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>

      {/* List */}
      {memories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/10 px-6 py-10 text-center">
          <Brain className="mx-auto mb-3 h-6 w-6 text-foreground/35" />
          <p className="text-sm text-foreground/55">
            {space.memory_enabled
              ? "No memories yet — chat in this space and the extractor will start saving durable facts here."
              : "Memory is off for this space. Turn it back on to start collecting facts."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.02]">
          {memories.map((m) => (
            <li
              key={m.id}
              className="group flex items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-foreground/[0.04]"
            >
              <Brain className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40" />
              {editingId === m.id ? (
                <Textarea
                  autoFocus
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                  onBlur={() => void commitEdit()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      (e.target as HTMLTextAreaElement).blur();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingId(null);
                      setEditVal("");
                    }
                  }}
                  className="min-h-[40px] flex-1 rounded-md border-foreground/10 bg-foreground/[0.03] text-sm"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(m)}
                  className="min-w-0 flex-1 cursor-text text-left text-foreground/85"
                  title="Click to edit"
                >
                  {m.content}
                </button>
              )}
              <button
                onClick={() => void onRemove(m.id)}
                aria-label="Delete memory"
                className="shrink-0 rounded-md p-1 text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Drop the `:tag` suffix on Ollama model ids (`llama3.1:8b` → `llama3.1`)
// for compact display in tab badges and chat-row meta. Falls through for
// OpenAI-style ids (no colon).
function trimModelLabel(id: string): string {
  if (!id) return "";
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : id;
}
