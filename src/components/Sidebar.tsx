import { useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  FileJson,
  FileText,
  Layers,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Sparkles,
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { SidebarTab } from "@/stores/uiStore";
import { cn, relativeDay } from "@/lib/utils";
import { exportSessionToFile } from "@/lib/export";
import type { Session } from "@/types";

/**
 * ChatGPT-style single-column sidebar.
 *
 * Layout (top → bottom):
 *
 *   ┌────────────────────────────┐
 *   │  Loach            [⊟]      │  ← brand + collapse toggle
 *   │                            │
 *   │  ✎  New chat               │  ← quick actions
 *   │  ⌕  Search chats           │
 *   │  ▢  Spaces                 │
 *   │  ✦  Snippets               │
 *   │  ▣  Models                 │
 *   │                            │
 *   │  PINNED                    │  ← chat history, grouped by date
 *   │   …chats…                  │
 *   │  TODAY                     │
 *   │   …chats…                  │
 *   │                            │
 *   ├────────────────────────────┤
 *   │  ⚙  Settings               │  ← bottom-pinned action
 *   └────────────────────────────┘
 *
 * Why one column (not the previous icon-rail + panel pattern):
 *
 * - Quick actions, navigation tabs, and the chat list share the same column,
 *   so users always know where to look. The old design split them across a
 *   narrow rail and a wider panel; clicking a tab "swapped" the panel out,
 *   which made the collapse toggle's effect inconsistent across tabs.
 * - Spaces / Snippets / Models are now full-canvas surfaces (see their
 *   `*Library.tsx` files). The sidebar's role becomes purely chat navigation
 *   plus quick links into those galleries — exactly what ChatGPT, Claude
 *   and Gemini do.
 * - One sidebar shape means `sidebarOpen` is the single source of truth for
 *   visibility. The toggle in the sidebar's top-right always collapses;
 *   the toggle in the TitleBar only renders when the sidebar is hidden,
 *   and always expands. Two states, two locations, one button visible at a
 *   time.
 */
export function Sidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);

  // Collapsed: render nothing. The TitleBar carries an expand button so the
  // user can bring the sidebar back. We deliberately don't render a thin
  // "rail" placeholder — the chat canvas takes the full width, which is what
  // users expect when they explicitly hid the sidebar.
  if (!sidebarOpen) return null;

  return (
    <aside className="glass-subtle relative flex h-full w-64 flex-col border-r">
      <SidebarTop />
      <Quicklinks />
      <ScrollArea className="flex-1 px-2 pb-2">
        <ChatList />
      </ScrollArea>
      <SidebarFooter />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Top — collapse toggle. We keep the brand in the TitleBar (avoids a
// duplicate Loach logo at the top of the window) and just put the toggle
// here, aligned to the right where ChatGPT, Notion, Linear all put it.
// ---------------------------------------------------------------------------

function SidebarTop() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  return (
    <div className="flex h-10 items-center justify-end px-2">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label="Hide sidebar"
        title="Hide sidebar"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 hover:bg-foreground/10 hover:text-foreground transition-colors"
      >
        <PanelLeft className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quicklinks — primary navigation. New chat is first, the three "library"
// surfaces follow, and Search lives between New chat and the libraries
// because it's the second-most-common verb.
// ---------------------------------------------------------------------------

function Quicklinks() {
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const newSession = useChatStore((s) => s.newSession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);

  const goToTab = (tab: SidebarTab) => {
    // Clearing override views ensures the new tab's canvas actually renders;
    // App.tsx prioritizes viewingSpaceId and viewingModel over sidebarTab.
    setViewingSpace(null);
    setSidebarTab(tab);
  };

  const handleNewChat = () => {
    setViewingSpace(null);
    setSidebarTab("chats");
    void newSession({ spaceId: null });
  };

  const handleSearch = () => {
    // Focus the global SearchBar that lives in the TitleBar — same UX as
    // hitting Ctrl/Cmd+K. We dispatch a custom event the SearchBar listens
    // for, so we don't have to hold a ref across the component tree.
    window.dispatchEvent(new CustomEvent("loach:focus-search"));
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
    <nav className="space-y-0.5 px-2 pb-3">
      <Quicklink
        icon={<SquarePen className="h-4 w-4" />}
        label="New chat"
        onClick={handleNewChat}
      />
      <Quicklink
        icon={<Search className="h-4 w-4" />}
        label="Search chats"
        onClick={handleSearch}
        kbd="⌘K"
      />
      <Quicklink
        icon={<Layers className="h-4 w-4" />}
        label="Spaces"
        onClick={() => goToTab("spaces")}
        active={tabActive("spaces")}
      />
      <Quicklink
        icon={<Sparkles className="h-4 w-4" />}
        label="Snippets"
        onClick={() => goToTab("snippets")}
        active={tabActive("snippets")}
      />
      <Quicklink
        icon={<Boxes className="h-4 w-4" />}
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
  kbd,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** Optional keyboard shortcut hint shown right-aligned. Cosmetic — the
   *  actual shortcut is owned by whichever component implements it. */
  kbd?: string;
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
      {kbd && (
        <span className="font-mono text-[10px] tracking-tight text-foreground/35">
          {kbd}
        </span>
      )}
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

  const handleSelect = (id: string) => {
    setViewingSpace(null);
    setSidebarTab("chats");
    void select(id);
  };

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

function SessionRow({
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
  const archiveChat = useChatStore((s) => s.archive);
  const remove = useChatStore((s) => s.remove);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);

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
        className={cn(
          "group/row relative flex items-center rounded-lg px-3 py-2 text-[13px] text-foreground/75 cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground overflow-hidden",
          active && "bg-foreground/[0.10] text-foreground",
        )}
        onClick={() => onSelect(session.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {session.pinned_at && (
          <Pin className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        )}
        {session.space_id && !session.pinned_at && (
          <Layers className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>

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
              aria-label="Chat actions"
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
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => exportSessionToFile(session.id, session.title, "md")}
            >
              <FileText className="h-4 w-4" /> Export as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => exportSessionToFile(session.id, session.title, "json")}
            >
              <FileJson className="h-4 w-4" /> Export as JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void archiveChat(session.id, true)}>
              <Archive className="h-4 w-4" /> Move to Archive
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => remove(session.id)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

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
        onClick={() => openSettingsTab("providers")}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
      >
        <Settings className="h-4 w-4 text-foreground/55" />
        <span>Settings</span>
      </button>
    </div>
  );
}
