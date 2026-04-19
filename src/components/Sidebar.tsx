import { useMemo, useState } from "react";
import {
  Archive,
  Cpu,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Settings,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Download,
  FileJson,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useChatStore } from "@/stores/chatStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { SidebarTab } from "@/stores/uiStore";
import { cn, relativeDay } from "@/lib/utils";
import { exportSessionToFile } from "@/lib/export";
import type { Session, Snippet, Space } from "@/types";

export function Sidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const openSettingsTab = useUIStore((s) => s.openSettingsTab);

  // Collapsed form: just the icon rail (no right column).
  if (!sidebarOpen) {
    return (
      <IconRail
        collapsed
        activeTab={sidebarTab}
        onSelectTab={setSidebarTab}
        onToggleSidebar={toggleSidebar}
        onOpenSettings={() => openSettingsTab("providers")}
      />
    );
  }

  // Open form: icon rail + contextual list panel.
  return (
    <aside className="flex h-full">
      <IconRail
        activeTab={sidebarTab}
        onSelectTab={setSidebarTab}
        onToggleSidebar={toggleSidebar}
        onOpenSettings={() => openSettingsTab("providers")}
      />
      <div className="glass-subtle flex h-full w-64 flex-col border-r">
        {sidebarTab === "chats" && <ChatsPanel />}
        {sidebarTab === "spaces" && <SpacesPanel />}
        {sidebarTab === "snippets" && <SnippetsPanel />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Left icon rail — tabs + Settings pinned at the bottom.
// ---------------------------------------------------------------------------

const RAIL_TABS: { value: SidebarTab; label: string; icon: typeof MessageSquare }[] = [
  { value: "chats", label: "Chats", icon: MessageSquare },
  { value: "spaces", label: "Spaces", icon: Layers },
  { value: "snippets", label: "Snippets", icon: Sparkles },
];

function IconRail({
  activeTab,
  onSelectTab,
  onToggleSidebar,
  onOpenSettings,
  collapsed = false,
}: {
  activeTab: SidebarTab;
  onSelectTab: (tab: SidebarTab) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  collapsed?: boolean;
}) {
  return (
    <div className="glass-subtle flex h-full w-20 flex-col items-stretch border-r py-2">
      <div className="mb-1 flex justify-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          aria-label={collapsed ? "Open sidebar" : "Collapse sidebar"}
          className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>

      <nav className="flex flex-1 flex-col items-stretch gap-0.5 px-2">
        {RAIL_TABS.map(({ value, label, icon: Icon }) => (
          <RailButton
            key={value}
            icon={<Icon className="h-5 w-5" />}
            label={label}
            active={activeTab === value}
            onClick={() => onSelectTab(value)}
          />
        ))}
      </nav>

      <div className="mt-1 flex flex-col items-stretch gap-0.5 border-t border-foreground/5 px-2 pt-2">
        <RailButton
          icon={<Settings className="h-5 w-5" />}
          label="Settings"
          active={false}
          onClick={onOpenSettings}
        />
      </div>
    </div>
  );
}

function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-medium leading-none transition-colors",
        "text-foreground/60 hover:bg-foreground/[0.07] hover:text-foreground",
        active && "bg-foreground/[0.10] text-foreground",
      )}
    >
      <span className="flex h-6 w-6 items-center justify-center">{icon}</span>
      <span className="tracking-tight">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Chats panel — list of sessions with "+ New chat" at top.
// ---------------------------------------------------------------------------

function ChatsPanel() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const select = useChatStore((s) => s.selectSession);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);

  const visible = useMemo(
    () =>
      sessions
        // Archived chats live in Settings → Archive. Hide them here.
        .filter((s) => !s.archived_at),
    [sessions],
  );

  // Split pinned from the rest; the relativeDay groupings keep a visual
  // rhythm users know from the old sidebar.
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

  const handleNewChat = () => {
    setViewingSpace(null);
    void newSession({ spaceId: null });
  };

  const handleSelect = (id: string) => {
    setViewingSpace(null);
    void select(id);
  };

  return (
    <>
      <PanelHeader title="Chats">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNewChat}
          aria-label="New chat"
          title="New chat"
          className="h-7 w-7 rounded-lg text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PanelHeader>

      <ScrollArea className="flex-1 px-2 pb-2">
        {empty && (
          <p className="px-3 py-2 text-xs text-foreground/40">
            No chats yet. Click "+" to start.
          </p>
        )}
        {pinned.length > 0 && (
          <GroupedList label="Pinned" sessions={pinned} activeId={activeId} onSelect={handleSelect} />
        )}
        {groups.today.length > 0 && (
          <GroupedList label="Today" sessions={groups.today} activeId={activeId} onSelect={handleSelect} />
        )}
        {groups.yesterday.length > 0 && (
          <GroupedList label="Yesterday" sessions={groups.yesterday} activeId={activeId} onSelect={handleSelect} />
        )}
        {groups.week.length > 0 && (
          <GroupedList label="This week" sessions={groups.week} activeId={activeId} onSelect={handleSelect} />
        )}
        {groups.older.length > 0 && (
          <GroupedList label="Older" sessions={groups.older} activeId={activeId} onSelect={handleSelect} />
        )}
      </ScrollArea>
    </>
  );
}

function GroupedList({
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
    <div className="mb-1">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/35">
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
          "group relative flex items-center rounded-2xl px-3 py-2 text-[13px] text-foreground/70 cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground overflow-hidden",
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
        {/* Fade overlay under the "..." button on hover or when menu is open */}
        <span
          className={cn(
            "pointer-events-none absolute right-0 top-0 h-full w-12 bg-gradient-to-l to-transparent transition-opacity",
            active ? "from-foreground/[0.10]" : "from-foreground/[0.07]",
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        />
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-foreground/10 transition-opacity z-10",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
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
        <Download className="hidden h-4 w-4" />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Spaces panel — lists all spaces, click opens the SpaceView.
// ---------------------------------------------------------------------------

function SpacesPanel() {
  const spaces = useSpaceStore((s) => s.spaces);
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setFormOpen = useSpaceStore((s) => s.setSpaceFormOpen);
  const removeSpace = useSpaceStore((s) => s.deleteSpace);

  return (
    <>
      <PanelHeader title="Spaces">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setFormOpen(true)}
          aria-label="New space"
          title="New space"
          className="h-7 w-7 rounded-lg text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PanelHeader>

      <ScrollArea className="flex-1 px-2 pb-2">
        {spaces.length === 0 && (
          <p className="px-3 py-2 text-xs text-foreground/40">
            No spaces yet. Click "+" to create one.
          </p>
        )}
        <ul className="space-y-0.5">
          {spaces.map((space) => (
            <SpaceRow
              key={space.id}
              space={space}
              active={space.id === viewingSpaceId}
              onOpen={() => setViewingSpace(space.id)}
              onDelete={() => void removeSpace(space.id)}
            />
          ))}
        </ul>
      </ScrollArea>
    </>
  );
}

function SpaceRow({
  space,
  active,
  onOpen,
  onDelete,
}: {
  space: Space;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li>
      <div
        className={cn(
          "group relative flex items-center rounded-2xl px-3 py-2 text-[13px] text-foreground/70 cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground overflow-hidden",
          active && "bg-foreground/[0.10] text-foreground",
        )}
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        <Layers className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        <span className="min-w-0 flex-1 truncate">{space.name}</span>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-foreground/10 transition-opacity z-10",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => e.stopPropagation()}
              aria-label="Space actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onOpen}>
              <Pencil className="h-4 w-4" /> Open / edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onDelete}
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
// Snippets panel — lists saved prompts, click runs into a fresh chat.
// ---------------------------------------------------------------------------

function SnippetsPanel() {
  const snippets = useSnippetStore((s) => s.snippets);
  const openDialog = useSnippetStore((s) => s.openDialog);
  const remove = useSnippetStore((s) => s.remove);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const primeComposer = useUIStore((s) => s.primeComposer);

  const runSnippet = async (snippet: Snippet) => {
    setViewingSpace(null);
    await newSession({
      spaceId: null,
      provider: snippet.provider ?? undefined,
      model: snippet.model ?? undefined,
    });
    primeComposer(snippet.prompt, []);
  };

  return (
    <>
      <PanelHeader title="Snippets">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openDialog("new")}
          aria-label="New snippet"
          title="New snippet"
          className="h-7 w-7 rounded-lg text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PanelHeader>

      <ScrollArea className="flex-1 px-2 pb-2">
        {snippets.length === 0 && (
          <p className="px-3 py-2 text-xs text-foreground/40">
            No snippets yet. Click "+" to save a reusable prompt.
          </p>
        )}
        <ul className="space-y-0.5">
          {snippets.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              onRun={() => void runSnippet(snippet)}
              onEdit={() => openDialog(snippet)}
              onDelete={() => void remove(snippet.id)}
            />
          ))}
        </ul>
      </ScrollArea>
    </>
  );
}

function SnippetRow({
  snippet,
  onRun,
  onEdit,
  onDelete,
}: {
  snippet: Snippet;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li>
      <div
        className="group relative flex items-center rounded-2xl px-3 py-2 text-[13px] text-foreground/70 cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground overflow-hidden"
        onClick={onRun}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        title={snippet.prompt}
      >
        <Sparkles className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{snippet.title}</span>
          {snippet.provider && snippet.model && (
            <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-foreground/40">
              <Cpu className="h-2.5 w-2.5" />
              {snippet.model}
            </span>
          )}
        </div>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-foreground/10 transition-opacity z-10",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => e.stopPropagation()}
              aria-label="Snippet actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onRun}>
              <Play className="h-4 w-4" /> Run
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onDelete}
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
// Shared panel header.
// ---------------------------------------------------------------------------

function PanelHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-3">
      <h2 className="text-sm font-semibold tracking-tight text-foreground/85">
        {title}
      </h2>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}
