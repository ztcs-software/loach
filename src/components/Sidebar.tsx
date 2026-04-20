import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  CircleAlert,
  Copy,
  Cpu,
  Download,
  FileJson,
  FileText,
  HardDrive,
  Layers,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Sliders,
  Sparkles,
  Trash2,
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
import { useModelsStore } from "@/stores/modelsStore";
import type { AdminProgress } from "@/stores/modelsStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { SidebarTab } from "@/stores/uiStore";
import { cn, formatBytes, relativeDay } from "@/lib/utils";
import { exportSessionToFile } from "@/lib/export";
import type { ModelInfo, Session, Snippet, Space } from "@/types";

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
        {sidebarTab === "models" && <ModelsPanel />}
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
  { value: "models", label: "Models", icon: Boxes },
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
// Models panel — lists installed Ollama models + OpenAI catalog; click a row
// to open the Modelfile editor in the main area.
// ---------------------------------------------------------------------------

function ModelsPanel() {
  const models = useModelsStore((s) => s.models);
  const loading = useModelsStore((s) => s.loading);
  const error = useModelsStore((s) => s.error);
  const hydrate = useModelsStore((s) => s.hydrate);
  const refresh = useModelsStore((s) => s.refresh);
  const viewingModel = useModelsStore((s) => s.viewingModel);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);
  const deleteModel = useModelsStore((s) => s.deleteModel);
  const copyModel = useModelsStore((s) => s.copyModel);
  const pullModel = useModelsStore((s) => s.pullModel);
  const runs = useModelsStore((s) => s.runs);
  const dismissRun = useModelsStore((s) => s.dismissRun);
  const cancelRun = useModelsStore((s) => s.cancelRun);

  // Lazy hydrate on first mount of this panel. Cheap because refresh() no-ops
  // when nothing is changing visibly and the user can retry manually.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [pullOpen, setPullOpen] = useState(false);
  const [pullTag, setPullTag] = useState("");

  const ollamaModels = useMemo(
    () => models.filter((m) => m.provider === "ollama"),
    [models],
  );
  const openaiModels = useMemo(
    () => models.filter((m) => m.provider === "openai"),
    [models],
  );

  const activeRuns = Object.entries(runs);

  const handleStartPull = async () => {
    const tag = pullTag.trim();
    if (!tag) return;
    setPullOpen(false);
    setPullTag("");
    await pullModel(tag);
  };

  return (
    <>
      <PanelHeader title="Models">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh models"
          title="Refresh models"
          className="h-7 w-7 rounded-lg text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <RefreshCw
            className={cn("h-4 w-4", loading && "animate-spin")}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setPullOpen(true)}
          aria-label="Pull model"
          title="Pull a new model"
          className="h-7 w-7 rounded-lg text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PanelHeader>

      {/* Inline pull form — tucked right below the header so the action flow
          is visible without a modal. Enter to confirm, Esc to cancel. */}
      {pullOpen && (
        <div className="border-b border-foreground/5 px-3 pb-3 pt-1">
          <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/35">
            Model tag
          </label>
          <div className="mt-1 flex gap-1">
            <Input
              autoFocus
              value={pullTag}
              onChange={(e) => setPullTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleStartPull();
                if (e.key === "Escape") {
                  setPullOpen(false);
                  setPullTag("");
                }
              }}
              placeholder="llama3.1:8b"
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              className="h-8 px-2"
              disabled={!pullTag.trim()}
              onClick={() => void handleStartPull()}
            >
              Pull
            </Button>
          </div>
          <p className="mt-1 text-[10px] text-foreground/40">
            Browse tags at{" "}
            <span className="font-mono">ollama.com/library</span>
          </p>
        </div>
      )}

      {/* Active runs — pull / create progress chips, one per stream. */}
      {activeRuns.length > 0 && (
        <div className="space-y-1 border-b border-foreground/5 px-2 py-2">
          {activeRuns.map(([id, run]) => (
            <RunChip
              key={id}
              run={run}
              onCancel={() => void cancelRun(id)}
              onDismiss={() => dismissRun(id)}
            />
          ))}
        </div>
      )}

      <ScrollArea className="flex-1 px-2 pb-2">
        {error && (
          <div className="mx-1 mt-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[11px] text-destructive">
            <div className="flex items-start gap-1.5">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* Ollama section */}
        <GroupLabel label={`Ollama (${ollamaModels.length})`} />
        {ollamaModels.length === 0 && !loading && (
          <p className="px-3 py-2 text-xs text-foreground/40">
            No models installed. Click "+" to pull one.
          </p>
        )}
        <ul className="space-y-0.5">
          {ollamaModels.map((m) => (
            <ModelRow
              key={`ollama-${m.id}`}
              model={m}
              active={viewingModel === m.id}
              onOpen={() => setViewingModel(m.id)}
              onDelete={() => {
                if (
                  confirm(
                    `Delete model "${m.id}"? This removes the model files from disk and cannot be undone.`,
                  )
                ) {
                  void deleteModel(m.id);
                }
              }}
              onDuplicate={() => {
                const dest = prompt(
                  `Duplicate "${m.id}" as…`,
                  `${m.id.split(":")[0]}-copy`,
                );
                if (dest && dest.trim()) {
                  void copyModel(m.id, dest.trim());
                }
              }}
            />
          ))}
        </ul>

        {/* OpenAI section — read-only. Only shown when the catalog loaded. */}
        {openaiModels.length > 0 && (
          <>
            <GroupLabel label={`OpenAI (${openaiModels.length})`} />
            <ul className="space-y-0.5">
              {openaiModels.map((m) => (
                <li
                  key={`openai-${m.id}`}
                  className="flex items-center gap-2 rounded-2xl px-3 py-2 text-[13px] text-foreground/70"
                  title="OpenAI-compatible models are read-only"
                >
                  <Cpu className="h-3 w-3 shrink-0 text-foreground/35" />
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </ScrollArea>
    </>
  );
}

function GroupLabel({ label }: { label: string }) {
  return (
    <div className="mt-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/35">
      {label}
    </div>
  );
}

function ModelRow({
  model,
  active,
  onOpen,
  onDelete,
  onDuplicate,
}: {
  model: ModelInfo;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sizeLabel = model.size ? formatBytes(model.size) : null;
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
        title={model.id}
      >
        <Cpu className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{model.id}</span>
          {(model.family || sizeLabel) && (
            <span className="mt-0.5 flex items-center gap-2 truncate text-[10px] text-foreground/40">
              {model.family && <span>{model.family}</span>}
              {sizeLabel && (
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="h-2.5 w-2.5" />
                  {sizeLabel}
                </span>
              )}
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
              aria-label="Model actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onOpen}>
              <Sliders className="h-4 w-4" /> Customize
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy className="h-4 w-4" /> Duplicate…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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

function RunChip({
  run,
  onCancel,
  onDismiss,
}: {
  run: AdminProgress;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pct =
    run.total > 0 ? Math.min(100, Math.round((run.completed / run.total) * 100)) : null;
  const verb = run.kind === "pull" ? "Pulling" : "Creating";
  const terminal = run.finished;
  return (
    <div
      className={cn(
        "rounded-xl border px-2.5 py-2 text-[11px]",
        terminal === "error"
          ? "border-destructive/30 bg-destructive/[0.06] text-destructive"
          : "border-foreground/10 bg-foreground/[0.04] text-foreground/70",
      )}
    >
      <div className="flex items-center gap-1.5">
        {terminal === null && (
          <Download className="h-3 w-3 shrink-0 animate-pulse" />
        )}
        {terminal === "ok" && (
          <Download className="h-3 w-3 shrink-0 text-emerald-500" />
        )}
        {terminal === "error" && <CircleAlert className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-medium">
          {verb} {run.target}
        </span>
        {terminal === null ? (
          <button
            type="button"
            onClick={onCancel}
            className="text-foreground/40 hover:text-foreground"
            aria-label="Cancel"
          >
            ✕
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            className="text-foreground/40 hover:text-foreground"
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-1 truncate text-[10px] text-foreground/50">
        {run.error ?? run.status}
      </div>
      {terminal === null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              "h-full bg-primary transition-[width]",
              pct === null && "w-1/3 animate-pulse",
            )}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}
    </div>
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
