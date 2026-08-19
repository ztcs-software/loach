import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Cpu,
  Folder as FolderIcon,
  FolderMinus,
  FolderOpen,
  GitFork,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Settings,
  SquarePen,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatLabelDot, ChatLabelSubmenu } from "@/components/ChatLabelMenu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "@/components/ConfirmDialog";
import { findChatLabel } from "@/lib/labels";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { SidebarTab } from "@/stores/uiStore";
import { cn, relativeDay } from "@/lib/utils";
import type { Folder, Session } from "@/types";

/**
 * ChatGPT-style sidebar with two states. The sidebar is ALWAYS rendered —
 * primary navigation is always one click away. The collapse/expand toggle
 * lives in the chat title bar (`ChatHeader`), so neither state of the
 * sidebar carries a toggle itself — items start flush at the top.
 *
 *   Expanded (w-64)              Collapsed rail (w-14)
 *   ┌────────────────────────┐   ┌────┐
 *   │  ✎  New chat           │   │ ✎  │
 *   │  ▢  Spaces             │   │ ▢  │
 *   │  ▤  Snippets           │   │ ▤  │
 *   │  ⌘  Models             │   │ ⌘  │
 *   │                        │   │    │
 *   │  PINNED                │   │    │
 *   │   …chats…              │   │    │
 *   │  TODAY                 │   │    │
 *   │   …chats…              │   │    │
 *   ├────────────────────────┤   ├────┤
 *   │  ⚙  Settings           │   │ ⚙  │
 *   └────────────────────────┘   └────┘
 *
 * Why never collapse to zero: the rail keeps the user's primary navigation
 * always one click away regardless of which canvas surface is active.
 */
export function Sidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);

  if (!sidebarOpen) {
    return <CollapsedRail />;
  }

  return (
    <aside className="glass-subtle relative flex h-full w-64 flex-col border-r">
      <Quicklinks />
      <ScrollArea className="flex-1 px-2 pb-2">
        <ChatList />
      </ScrollArea>
      <SidebarFooter />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Collapsed rail — narrow icon-only column shown when `sidebarOpen` is false.
// Mirrors the expanded layout's regions: primary actions, tab navigators,
// settings on the bottom. The collapse/expand toggle now lives in the chat
// title bar, so neither state of the sidebar carries it itself — both
// states' navigation starts flush at the top.
// ---------------------------------------------------------------------------

function CollapsedRail() {
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const openSettingsTab = useUIStore((s) => s.openSettingsTab);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);

  const goToTab = (tab: SidebarTab) => {
    setViewingSpace(null);
    setViewingModel(null);
    setSidebarTab(tab);
  };

  const handleNewChat = () => {
    setViewingSpace(null);
    setViewingModel(null);
    setSidebarTab("chats");
    void newSession({ spaceId: null });
  };

  return (
    <aside className="glass-subtle relative flex h-full w-14 shrink-0 flex-col items-center border-r">
      <nav className="flex flex-col items-center gap-1 px-1 pt-3">
        <RailIcon
          icon={<SquarePen className="h-4 w-4" />}
          label="New chat"
          onClick={handleNewChat}
        />
        <RailIcon
          icon={<Layers className="h-4 w-4" />}
          label="Spaces"
          onClick={() => goToTab("spaces")}
          active={sidebarTab === "spaces"}
        />
        <RailIcon
          icon={<SquareTerminal className="h-4 w-4" />}
          label="Snippets"
          onClick={() => goToTab("snippets")}
          active={sidebarTab === "snippets"}
        />
        <RailIcon
          icon={<Cpu className="h-4 w-4" />}
          label="Models"
          onClick={() => goToTab("models")}
          active={sidebarTab === "models"}
        />
      </nav>

      <div className="flex-1" />

      {/* Bottom slot — settings, mirrors the expanded sidebar's footer. */}
      <div className="border-t border-foreground/[0.06] w-full p-2 flex justify-center">
        <RailIcon
          icon={<Settings className="h-4 w-4" />}
          label="Settings"
          onClick={() => openSettingsTab("general")}
        />
      </div>
    </aside>
  );
}

function RailIcon({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-foreground/[0.10] text-foreground"
          : "text-foreground/65 hover:bg-foreground/[0.07] hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Quicklinks — primary navigation. New chat is first, the three "library"
// surfaces follow. Search lives in the title bar (centered pill); it is not
// duplicated here.
// ---------------------------------------------------------------------------

function Quicklinks() {
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const newSession = useChatStore((s) => s.newSession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);

  const goToTab = (tab: SidebarTab) => {
    // Clearing override views ensures the new tab's canvas actually renders;
    // App.tsx prioritizes viewingSpaceId and viewingModel over sidebarTab.
    setViewingSpace(null);
    setViewingModel(null);
    setSidebarTab(tab);
  };

  const handleNewChat = () => {
    setViewingSpace(null);
    setViewingModel(null);
    setSidebarTab("chats");
    void newSession({ spaceId: null });
  };

  // A quicklink is "active" when its tab matches the current sidebarTab,
  // EXCEPT for "chats" which we only mark active when the user is actually
  // looking at a chat (an active session id) — otherwise the active row in
  // the chat list serves as the navigation indicator and a redundant
  // highlight on the New chat tile would be misleading.
  const tabActive = (t: SidebarTab) =>
    t === "chats"
      ? sidebarTab === "chats" && !activeSessionId
      : sidebarTab === t;

  return (
    <nav className="space-y-0.5 px-2 pb-3 pt-3">
      <Quicklink
        icon={<SquarePen className="h-4 w-4" />}
        label="New chat"
        onClick={handleNewChat}
      />
      <Quicklink
        icon={<Layers className="h-4 w-4" />}
        label="Spaces"
        onClick={() => goToTab("spaces")}
        active={tabActive("spaces")}
      />
      <Quicklink
        icon={<SquareTerminal className="h-4 w-4" />}
        label="Snippets"
        onClick={() => goToTab("snippets")}
        active={tabActive("snippets")}
      />
      <Quicklink
        icon={<Cpu className="h-4 w-4" />}
        label="Models"
        onClick={() => goToTab("models")}
        active={tabActive("models")}
      />
    </nav>
  );
}

function Quicklink({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/link flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-foreground/[0.10] text-foreground"
          : "text-foreground/75 hover:bg-foreground/[0.07] hover:text-foreground",
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground/55 group-hover/link:text-foreground/80">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Chat drag-and-drop. Dropping one chat row onto another groups them into a
// folder; dropping a foldered chat onto a date group pulls it back out.
//
// Tauri requires `dragDropEnabled: false` in tauri.conf.json for HTML5 drag
// events to reach the webview at all — it's already off for ChatInput's file
// drop, and these rows ride on the same setting.
// ---------------------------------------------------------------------------

/** MIME type stamped on the drag so the composer's textarea (which accepts
 *  `text/plain` and `Files`) refuses a chat row as a drop. The payload is
 *  never read back — see `draggedChatId`. */
const CHAT_DRAG_MIME = "application/x-loach-chat";

/** Id of the chat being dragged, or null when no in-app drag is running.
 *  Module state rather than `dataTransfer` because `getData()` is blocked
 *  during `dragover` (only `types` is exposed there), and we need the
 *  dragged chat's *identity* to decide whether a target is even a valid
 *  drop. A drag never spans windows, so one slot is enough. Also acts as
 *  the "is this our drag?" flag: a file drag leaves it null and every
 *  target below declines. */
let draggedChatId: string | null = null;

/** Wire an element up as a drop target for a chat-row drag.
 *  `canDrop` decides per-drag whether this target is live — declining lets
 *  the event bubble to an enclosing target instead. Returns the props to
 *  spread plus an `over` flag for the highlight. */
function useChatDrop(
  canDrop: (dragged: Session) => boolean,
  onDrop: (dragged: Session) => void,
) {
  const [over, setOver] = useState(false);

  const resolve = (e: React.DragEvent): Session | null => {
    // The MIME type is the authority on "is this our drag?", not
    // `draggedChatId` alone. If the source row unmounts mid-drag (it
    // regroups the moment its store write lands), the native `dragend`
    // fires on a detached node and never reaches React's delegated
    // listener, so the module flag can outlive its drag — and a later
    // FILE drop onto a chat row would otherwise resolve that stale
    // session and silently file it into a folder.
    if (!draggedChatId || !e.dataTransfer.types.includes(CHAT_DRAG_MIME)) {
      return null;
    }
    const dragged = useChatStore
      .getState()
      .sessions.find((s) => s.id === draggedChatId);
    return dragged && canDrop(dragged) ? dragged : null;
  };

  return {
    over,
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        if (!resolve(e)) return;
        // preventDefault is what makes this a valid drop target at all;
        // stopPropagation keeps an enclosing target (the folder block, a
        // date group) from claiming the same drop underneath us.
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        // `dragleave` also fires when the pointer crosses into a CHILD of
        // this element, which would flicker the highlight off and on as
        // the cursor passes over the icons and the title.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const dragged = resolve(e);
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(dragged);
      },
    },
  };
}

/** Tailwind for a live drop target. */
const DROP_RING = "ring-1 ring-inset ring-primary/50 bg-primary/[0.08]";

/** Which folders are expanded, persisted so they reopen as the user left
 *  them. Stored directly in localStorage rather than in a store: it's one
 *  list of ids that only the sidebar reads. Mirrors ParameterPanel's
 *  `viewMode`. */
const OPEN_FOLDERS_KEY = "loach:open-folders";

function readOpenFolders(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(OPEN_FOLDERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [],
    );
  } catch {
    // Corrupt or hand-edited value: fall back to all-collapsed rather than
    // taking the sidebar down with it.
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Chat list — grouped by relativeDay, with "Pinned" on top and "Folders"
// between the two. This is the bulk of the sidebar content; everything else
// is chrome.
// ---------------------------------------------------------------------------

function ChatList() {
  const sessions = useChatStore((s) => s.sessions);
  const folders = useChatStore((s) => s.folders);
  const activeId = useChatStore((s) => s.activeSessionId);
  const select = useChatStore((s) => s.selectSession);
  const moveToFolder = useChatStore((s) => s.moveToFolder);
  const createFolderWith = useChatStore((s) => s.createFolderWith);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const { prompt } = useConfirm();

  const [openFolders, setOpenFolders] = useState<Set<string>>(readOpenFolders);
  useEffect(() => {
    window.localStorage.setItem(
      OPEN_FOLDERS_KEY,
      JSON.stringify([...openFolders]),
    );
  }, [openFolders]);

  const visible = useMemo(
    () => sessions.filter((s) => !s.archived_at),
    [sessions],
  );

  const { pinned, byFolder, groups, empty } = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    const pinnedArr = visible
      .filter((s) => s.pinned_at)
      .sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0));

    const bf = new Map<string, Session[]>(folders.map((f) => [f.id, []]));
    const gs: Record<string, Session[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };
    for (const s of visible) {
      // A `folder_id` pointing at a folder that isn't there (only reachable
      // via a hand-edited snapshot) is treated as loose, so the chat still
      // renders somewhere instead of vanishing into a section that never
      // draws.
      if (s.folder_id && known.has(s.folder_id)) {
        bf.get(s.folder_id)?.push(s);
        // Foldered chats never fall through to the date groups. Pinned ones
        // still appear in "Pinned" as well — a pin is a shortcut to the top
        // of the sidebar, and filing a chat shouldn't silently revoke it.
        continue;
      }
      if (s.pinned_at) continue;
      gs[relativeDay(s.updated_at)].push(s);
    }
    return {
      pinned: pinnedArr,
      byFolder: bf,
      groups: gs,
      empty: visible.length === 0,
    };
  }, [visible, folders]);

  const handleSelect = useCallback(
    (id: string) => {
      setViewingSpace(null);
      setViewingModel(null);
      setSidebarTab("chats");
      void select(id);
    },
    [setViewingSpace, setViewingModel, setSidebarTab, select],
  );

  const toggleFolder = useCallback((id: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Chat dropped on another chat. If the target already lives in a folder
   *  the dragged chat joins it; otherwise this is the create-a-folder
   *  gesture and we ask for a name first. */
  const handleDropOnChat = useCallback(
    (dragged: Session, target: Session) => {
      void (async () => {
        const known = useChatStore.getState().folders;
        const targetFolder =
          target.folder_id && known.some((f) => f.id === target.folder_id)
            ? target.folder_id
            : null;
        if (targetFolder) {
          await moveToFolder(dragged.id, targetFolder);
          return;
        }
        const name = await prompt({
          title: "New folder",
          body: `“${target.title || "Untitled"}” and “${dragged.title || "Untitled"}” will be grouped into it.`,
          defaultValue: "New folder",
          placeholder: "Folder name",
          confirmLabel: "Create folder",
        });
        const trimmed = name?.trim();
        if (!trimmed) return;
        const folder = await createFolderWith(trimmed, [target.id, dragged.id]);
        // Open it: the two chats just left the list the user was looking at,
        // and a collapsed folder would read as "where did they go?". This
        // persists like any other toggle, so it's collapsed-by-default from
        // the next launch onward only if the user collapses it.
        setOpenFolders((prev) => new Set(prev).add(folder.id));
      })();
    },
    [moveToFolder, createFolderWith, prompt],
  );

  const handleDropInFolder = useCallback(
    (dragged: Session, folder: Folder) => {
      void moveToFolder(dragged.id, folder.id);
    },
    [moveToFolder],
  );

  /** Chat dropped on a date group — pull it out of whatever folder it's in. */
  const handleDropOut = useCallback(
    (dragged: Session) => {
      void moveToFolder(dragged.id, null);
    },
    [moveToFolder],
  );

  if (empty) {
    return (
      <p className="px-3 py-4 text-xs text-foreground/40">
        Your conversations will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3 pt-1">
      {pinned.length > 0 && (
        <Group label="Pinned" sessions={pinned} activeId={activeId} onSelect={handleSelect} onDropOnChat={handleDropOnChat} />
      )}
      {folders.length > 0 && (
        <FolderSection
          folders={folders}
          byFolder={byFolder}
          openFolders={openFolders}
          activeId={activeId}
          onToggle={toggleFolder}
          onSelect={handleSelect}
          onDropOnChat={handleDropOnChat}
          onDropInFolder={handleDropInFolder}
        />
      )}
      {groups.today.length > 0 && (
        <Group label="Today" sessions={groups.today} activeId={activeId} onSelect={handleSelect} onDropOnChat={handleDropOnChat} onDropOut={handleDropOut} />
      )}
      {groups.yesterday.length > 0 && (
        <Group label="Yesterday" sessions={groups.yesterday} activeId={activeId} onSelect={handleSelect} onDropOnChat={handleDropOnChat} onDropOut={handleDropOut} />
      )}
      {groups.week.length > 0 && (
        <Group label="This week" sessions={groups.week} activeId={activeId} onSelect={handleSelect} onDropOnChat={handleDropOnChat} onDropOut={handleDropOut} />
      )}
      {groups.older.length > 0 && (
        <Group label="Older" sessions={groups.older} activeId={activeId} onSelect={handleSelect} onDropOnChat={handleDropOnChat} onDropOut={handleDropOut} />
      )}
    </div>
  );
}

function Group({
  label,
  sessions,
  activeId,
  onSelect,
  onDropOnChat,
  onDropOut,
}: {
  label: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDropOnChat: (dragged: Session, target: Session) => void;
  /** Passed for the date groups only. Dropping a foldered chat on one of
   *  them files it back out to the loose list. "Pinned" doesn't take drops
   *  — dropping there would read as "pin this", which isn't what happens. */
  onDropOut?: (dragged: Session) => void;
}) {
  const { over, dropProps } = useChatDrop(
    (dragged) => !!onDropOut && dragged.folder_id !== null,
    (dragged) => onDropOut?.(dragged),
  );

  return (
    <div>
      {/* The caption — not the whole group — is the drop target. Rows inside
          take drops too, but they mean something else (group these two into
          a folder), so ringing the entire group would promise a behaviour
          most of its area doesn't have. */}
      <div
        {...dropProps}
        className={cn(
          "rounded px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/40",
          over && DROP_RING,
        )}
      >
        {label}
      </div>
      <ul className="space-y-0.5">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={onSelect}
            onDropOnChat={onDropOnChat}
          />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folders — a section between "Pinned" and the date groups. Folders are
// created by dragging one chat row onto another, are flat (never nested),
// and start collapsed; the open set is persisted in localStorage.
// ---------------------------------------------------------------------------

function FolderSection({
  folders,
  byFolder,
  openFolders,
  activeId,
  onToggle,
  onSelect,
  onDropOnChat,
  onDropInFolder,
}: {
  folders: Folder[];
  byFolder: Map<string, Session[]>;
  openFolders: Set<string>;
  activeId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDropOnChat: (dragged: Session, target: Session) => void;
  onDropInFolder: (dragged: Session, folder: Folder) => void;
}) {
  return (
    <div>
      <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/40">
        Folders
      </div>
      <ul className="space-y-0.5">
        {folders.map((f) => (
          <FolderRow
            key={f.id}
            folder={f}
            sessions={byFolder.get(f.id) ?? []}
            open={openFolders.has(f.id)}
            activeId={activeId}
            onToggle={onToggle}
            onSelect={onSelect}
            onDropOnChat={onDropOnChat}
            onDropInFolder={onDropInFolder}
          />
        ))}
      </ul>
    </div>
  );
}

function FolderRow({
  folder,
  sessions,
  open,
  activeId,
  onToggle,
  onSelect,
  onDropOnChat,
  onDropInFolder,
}: {
  folder: Folder;
  sessions: Session[];
  open: boolean;
  activeId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDropOnChat: (dragged: Session, target: Session) => void;
  onDropInFolder: (dragged: Session, folder: Folder) => void;
}) {
  const renameFolder = useChatStore((s) => s.renameFolder);
  const removeFolder = useChatStore((s) => s.removeFolder);
  const { confirm, prompt } = useConfirm();
  const [menuOpen, setMenuOpen] = useState(false);

  // The whole block — header plus the expanded children — takes drops, so
  // the user doesn't have to hit the header exactly. Rows inside stop
  // propagation when they accept a drop themselves.
  const { over, dropProps } = useChatDrop(
    (dragged) => dragged.folder_id !== folder.id,
    (dragged) => onDropInFolder(dragged, folder),
  );

  const count = `${sessions.length} chat${sessions.length === 1 ? "" : "s"}`;

  return (
    <li {...dropProps} className={cn("rounded-lg", over && DROP_RING)}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} folder: ${folder.name} (${count})`}
        className={cn(
          "group/row relative flex items-center rounded-lg px-3 py-2 text-[13px] font-medium text-foreground/75 cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground overflow-hidden",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
        onClick={() => onToggle(folder.id)}
        onKeyDown={(e) => {
          if (
            e.target === e.currentTarget &&
            (e.key === "Enter" || e.key === " ")
          ) {
            e.preventDefault();
            onToggle(folder.id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {open ? (
          <ChevronDown className="mr-1 h-3.5 w-3.5 shrink-0 text-foreground/45" />
        ) : (
          <ChevronRight className="mr-1 h-3.5 w-3.5 shrink-0 text-foreground/45" />
        )}
        {open ? (
          <FolderOpen className="mr-1.5 h-4 w-4 shrink-0 text-foreground/55" />
        ) : (
          <FolderIcon className="mr-1.5 h-4 w-4 shrink-0 text-foreground/55" />
        )}
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>

        {/* Chat count shares the right slot with the kebab, the way the
            unread dot does on a chat row: visible at rest, out of the way
            on hover. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-foreground/40 transition-opacity",
            menuOpen ? "opacity-0" : "opacity-100 group-hover/row:opacity-0",
          )}
        >
          {sessions.length}
        </span>

        <span
          className={cn(
            "pointer-events-none absolute right-0 top-0 h-full w-10 bg-gradient-to-l from-foreground/[0.07] to-transparent transition-opacity",
            menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
          )}
        />
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-foreground/10 transition-opacity z-10",
                menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
              )}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Actions for folder: ${folder.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuLabel>Folder</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() =>
                void (async () => {
                  const name = await prompt({
                    title: "Rename folder",
                    defaultValue: folder.name,
                    placeholder: "Folder name",
                    confirmLabel: "Rename",
                  });
                  const trimmed = name?.trim();
                  if (trimmed && trimmed !== folder.name) {
                    await renameFolder(folder.id, trimmed);
                  }
                })()
              }
            >
              <Pencil className="h-4 w-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void (async () => {
                  const ok = await confirm({
                    title: "Delete this folder?",
                    body:
                      sessions.length > 0
                        ? `“${folder.name}” will be removed. The ${count} inside are kept — they move back to the main list.`
                        : `“${folder.name}” is empty and will be removed.`,
                    confirmLabel: "Delete folder",
                    destructive: true,
                  });
                  if (ok) await removeFolder(folder.id);
                })()
              }
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open &&
        (sessions.length > 0 ? (
          <ul className="space-y-0.5 pl-3">
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeId}
                onSelect={onSelect}
                onDropOnChat={onDropOnChat}
              />
            ))}
          </ul>
        ) : (
          <p className="py-1.5 pl-9 pr-3 text-xs text-foreground/40">
            Empty — drag a chat here.
          </p>
        ))}
    </li>
  );
}

const SessionRow = memo(function SessionRowImpl({
  session,
  active,
  onSelect,
  onDropOnChat,
}: {
  session: Session;
  active: boolean;
  onSelect: (id: string) => void;
  onDropOnChat: (dragged: Session, target: Session) => void;
}) {
  const rename = useChatStore((s) => s.rename);
  const pinChat = useChatStore((s) => s.pin);
  const setLabel = useChatStore((s) => s.setLabel);
  const labelDef = findChatLabel(session.label);
  const archiveChat = useChatStore((s) => s.archive);
  const moveToFolder = useChatStore((s) => s.moveToFolder);
  const remove = useChatStore((s) => s.remove);
  const { confirm } = useConfirm();
  const [dragging, setDragging] = useState(false);
  const { over, dropProps } = useChatDrop(
    (dragged) =>
      dragged.id !== session.id &&
      // Already in the same folder — the drop would be a no-op, so decline
      // and let the folder block underneath show the (also inert) state.
      !(dragged.folder_id !== null && dragged.folder_id === session.folder_id),
    (dragged) => onDropOnChat(dragged, session),
  );
  // Per-row activity flags. `generating` is true if this session has the
  // running stream OR is parked in the queue waiting for it. `unread` is
  // a sticky flag set by the store when an assistant turn finishes on a
  // session the user wasn't viewing — cleared by `selectSession`.
  // We keep generating winning over unread: a chat that's still streaming
  // hasn't produced a "new reply to read" yet, so the spinner is the
  // truthful signal.
  const generating = useChatStore(
    (s) =>
      (s.runningTask?.sessionId === session.id && s.isStreaming) ||
      s.queue.some((t) => t.sessionId === session.id),
  );
  const unread = useChatStore((s) => !!s.unread[session.id]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);

  // Seed the draft from the live title at the moment editing begins. Rows
  // mount before a new chat is auto-titled, so the initial
  // `useState(session.title)` ("New chat") would otherwise be committed on a
  // click-away the user never meant as a rename — silently reverting the
  // auto-title. Done in the trigger (not an effect on `session.title`) so an
  // auto-title or a rename from another surface landing MID-edit can't
  // clobber a half-typed draft.
  const beginRename = () => {
    setDraft(session.title);
    setEditing(true);
  };

  if (editing) {
    return (
      <li>
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft !== session.title) {
              void rename(session.id, draft.trim());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(session.title);
              setEditing(false);
            }
          }}
          className="h-8 text-sm"
        />
      </li>
    );
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        draggable
        {...dropProps}
        onDragStart={(e) => {
          draggedChatId = session.id;
          setDragging(true);
          // Backstop for the row's own `onDragEnd`: this row may unmount
          // mid-drag (it regroups as soon as the move persists), and React's
          // delegated handler never fires for a detached node. The window
          // listener outlives the row, so the module flag can't be stranded
          // into the next drag.
          window.addEventListener(
            "dragend",
            () => {
              draggedChatId = null;
            },
            { once: true, capture: true },
          );
          // The payload is never read back (see `draggedChatId`), but a
          // drag needs *some* data to start, and this custom type keeps
          // the composer's textarea from accepting the row as text.
          e.dataTransfer.setData(CHAT_DRAG_MIME, session.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          draggedChatId = null;
          setDragging(false);
        }}
        // The dot's own `role="img"` label never reaches a screen reader
        // here — an explicit aria-label on a role="button" replaces its
        // contents — so the colour has to be spelled out in this string.
        aria-label={`Open chat: ${session.title || "Untitled"}${
          labelDef ? ` (${labelDef.name} label)` : ""
        }`}
        className={cn(
          "group/row relative flex items-center rounded-lg px-3 py-2 text-[13px] text-foreground/75 cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground overflow-hidden",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          active && "bg-foreground/[0.10] text-foreground",
          dragging && "opacity-40",
          over && DROP_RING,
        )}
        onClick={() => onSelect(session.id)}
        onKeyDown={(e) => {
          // Only when the row itself is focused — not when Enter/Space bubbles
          // up from the nested kebab trigger (Radix activates it on those keys).
          if (
            e.target === e.currentTarget &&
            (e.key === "Enter" || e.key === " ")
          ) {
            e.preventDefault();
            onSelect(session.id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        <ChatLabelDot label={session.label} className="mr-1.5" />
        {session.pinned_at && (
          <Pin className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        )}
        {session.forked_from_session_id && !session.pinned_at && (
          <GitFork
            className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35"
            aria-label="Forked chat"
          />
        )}
        {session.space_id &&
          !session.pinned_at &&
          !session.forked_from_session_id && (
            <Layers className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
          )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>

        {/* Activity indicator — shares the right-side slot with the kebab.
            When the row isn't hovered (and the menu isn't open), this is
            visible: a spinner if the chat is still generating, an accent
            dot if it has unread assistant content. On hover the kebab
            takes the slot and the indicator fades out. */}
        {(generating || unread) && (
          <span
            aria-hidden
            aria-label={
              generating ? "Generating reply" : "Unread assistant reply"
            }
            className={cn(
              "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 transition-opacity",
              menuOpen
                ? "opacity-0"
                : "opacity-100 group-hover/row:opacity-0",
            )}
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            ) : (
              <span className="block h-2 w-2 rounded-full bg-primary shadow-[0_0_4px_hsl(var(--primary)/0.55)]" />
            )}
          </span>
        )}

        {/* Fade gradient under the kebab so the truncated title doesn't
            butt up against the icon when it appears on hover. */}
        <span
          className={cn(
            "pointer-events-none absolute right-0 top-0 h-full w-10 bg-gradient-to-l to-transparent transition-opacity",
            active ? "from-foreground/[0.10]" : "from-foreground/[0.07]",
            menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
          )}
        />
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-foreground/10 transition-opacity z-10",
                menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
              )}
              onClick={(e) => e.stopPropagation()}
              // Distinguish from the chat-header kebab which carries the
              // same icon and lives on the same page. Screen readers
              // otherwise hear three "Chat actions" buttons (two sidebar
              // rows + the header) with no way to tell which one's which.
              aria-label={`Actions for chat: ${session.title || "Untitled"}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuLabel>Chat</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => pinChat(session.id, !session.pinned_at)}>
              {session.pinned_at ? (
                <>
                  <PinOff className="h-4 w-4" /> Unpin
                </>
              ) : (
                <>
                  <Pin className="h-4 w-4" /> Pin this chat
                </>
              )}
            </DropdownMenuItem>
            <ChatLabelSubmenu
              value={session.label}
              onSelect={(label) => void setLabel(session.id, label)}
            />
            <DropdownMenuItem onSelect={beginRename}>
              <Pencil className="h-4 w-4" /> Rename
            </DropdownMenuItem>
            {session.folder_id && (
              <DropdownMenuItem
                onSelect={() => void moveToFolder(session.id, null)}
              >
                <FolderMinus className="h-4 w-4" /> Remove from folder
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void archiveChat(session.id, true)}>
              <Archive className="h-4 w-4" /> Move to archive
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void (async () => {
                  const ok = await confirm({
                    title: "Delete this chat?",
                    body: `“${session.title || "Untitled"}” and all its messages will be permanently deleted. This cannot be undone.`,
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) await remove(session.id);
                })()
              }
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
});

// ---------------------------------------------------------------------------
// Footer — Settings only. Profile/account isn't a concept in Loach (it's a
// local-first app), so we just pin the gear here where ChatGPT puts the
// user avatar.
// ---------------------------------------------------------------------------

function SidebarFooter() {
  const openSettingsTab = useUIStore((s) => s.openSettingsTab);
  return (
    <div className="border-t border-foreground/[0.06] p-2">
      <button
        type="button"
        onClick={() => openSettingsTab("general")}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
      >
        <Settings className="h-4 w-4 text-foreground/55" />
        <span>Settings</span>
      </button>
    </div>
  );
}
