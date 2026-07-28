import { memo, useCallback, useMemo, useState } from "react";
import {
  Archive,
  Cpu,
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
import type { Session } from "@/types";

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
// Chat list — grouped by relativeDay, with a "Pinned" group on top. This is
// the bulk of the sidebar content; everything else is chrome.
// ---------------------------------------------------------------------------

function ChatList() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const select = useChatStore((s) => s.selectSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);

  const visible = useMemo(
    () => sessions.filter((s) => !s.archived_at),
    [sessions],
  );

  const { pinned, groups, empty } = useMemo(() => {
    const pinnedArr = visible
      .filter((s) => s.pinned_at)
      .sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0));
    const rest = visible.filter((s) => !s.pinned_at);
    const gs: Record<string, Session[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };
    for (const s of rest) gs[relativeDay(s.updated_at)].push(s);
    return {
      pinned: pinnedArr,
      groups: gs,
      empty: visible.length === 0,
    };
  }, [visible]);

  const handleSelect = useCallback(
    (id: string) => {
      setViewingSpace(null);
      setViewingModel(null);
      setSidebarTab("chats");
      void select(id);
    },
    [setViewingSpace, setViewingModel, setSidebarTab, select],
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
        <Group label="Pinned" sessions={pinned} activeId={activeId} onSelect={handleSelect} />
      )}
      {groups.today.length > 0 && (
        <Group label="Today" sessions={groups.today} activeId={activeId} onSelect={handleSelect} />
      )}
      {groups.yesterday.length > 0 && (
        <Group label="Yesterday" sessions={groups.yesterday} activeId={activeId} onSelect={handleSelect} />
      )}
      {groups.week.length > 0 && (
        <Group label="This week" sessions={groups.week} activeId={activeId} onSelect={handleSelect} />
      )}
      {groups.older.length > 0 && (
        <Group label="Older" sessions={groups.older} activeId={activeId} onSelect={handleSelect} />
      )}
    </div>
  );
}

function Group({
  label,
  sessions,
  activeId,
  onSelect,
}: {
  label: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/40">
        {label}
      </div>
      <ul className="space-y-0.5">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

const SessionRow = memo(function SessionRowImpl({
  session,
  active,
  onSelect,
}: {
  session: Session;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const rename = useChatStore((s) => s.rename);
  const pinChat = useChatStore((s) => s.pin);
  const setLabel = useChatStore((s) => s.setLabel);
  const labelDef = findChatLabel(session.label);
  const archiveChat = useChatStore((s) => s.archive);
  const remove = useChatStore((s) => s.remove);
  const { confirm } = useConfirm();
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
