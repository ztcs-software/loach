import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Pencil,
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
import { useUIStore } from "@/stores/uiStore";
import { cn, relativeDay } from "@/lib/utils";
import { exportSessionToFile } from "@/lib/export";
import { SpaceList } from "@/components/SpaceList";
import type { Session } from "@/types";

export function Sidebar() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const select = useChatStore((s) => s.selectSession);
  const newSession = useChatStore((s) => s.newSession);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const groups = useMemo(() => {
    const out: Record<string, Session[]> = { today: [], yesterday: [], week: [], older: [] };
    for (const s of sessions) {
      out[relativeDay(s.updated_at)].push(s);
    }
    return out;
  }, [sessions]);

  if (!sidebarOpen) {
    return (
      <div className="glass-subtle flex h-full w-14 flex-col items-center gap-2 border-r py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Open sidebar"
          className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => newSession()}
          aria-label="New chat"
          className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <aside className="glass-subtle flex h-full w-64 flex-col border-r">
      <div className="flex items-center gap-2 p-3">
        <Button
          className="flex-1 justify-start rounded-2xl border-foreground/10 bg-foreground/[0.04] text-foreground/85 hover:bg-foreground/10 hover:text-foreground"
          variant="outline"
          onClick={() => newSession()}
        >
          <Plus className="h-4 w-4" />
          New chat
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Collapse sidebar"
          className="rounded-xl text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>
      <SpaceList />
      <ChatList
        groups={groups}
        activeId={activeId}
        onSelect={select}
        empty={sessions.length === 0}
      />
      <div className="border-t border-foreground/5 p-2">
        <Button
          variant="ghost"
          className="w-full justify-start rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Button>
      </div>
    </aside>
  );
}

function ChatList({
  groups,
  activeId,
  onSelect,
  empty,
}: {
  groups: Record<string, Session[]>;
  activeId: string | null;
  onSelect: (id: string) => void;
  empty: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const totalCount = Object.values(groups).reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/35 hover:text-foreground/60 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <MessageSquare className="h-3 w-3" />
          Chats
          {totalCount > 0 && (
            <span className="ml-0.5 text-foreground/25">{totalCount}</span>
          )}
        </button>
      </div>
      {expanded && (
        <ScrollArea className="flex-1 px-2">
          <ul className="space-y-0.5 pb-4">
            {(() => {
              const all = [...groups.today, ...groups.yesterday, ...groups.week, ...groups.older];
              const pinned = all.filter((s) => s.pinned_at).sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0));
              const unpinned = all.filter((s) => !s.pinned_at);
              return [...pinned, ...unpinned];
            })().map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeId}
                onSelect={onSelect}
              />
            ))}
            {empty && (
              <p className="px-3 text-xs text-foreground/40">
                No chats yet. Click "New chat" to start.
              </p>
            )}
          </ul>
        </ScrollArea>
      )}
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
        {session.space_id && (
          <Layers className="mr-1.5 h-3 w-3 shrink-0 text-foreground/35" />
        )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {/* Fade overlay under the "..." button on hover or when menu is open */}
        <span className={cn(
          "pointer-events-none absolute right-0 top-0 h-full w-12 bg-gradient-to-l to-transparent transition-opacity",
          active ? "from-foreground/[0.10]" : "from-foreground/[0.07]",
          (menuOpen) ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )} />
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
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuLabel>Chat</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => pinChat(session.id, !session.pinned_at)}>
              {session.pinned_at ? (
                <><PinOff className="h-4 w-4" /> Unpin</>
              ) : (
                <><Pin className="h-4 w-4" /> Pin this chat</>
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
