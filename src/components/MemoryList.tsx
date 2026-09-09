import { useMemo, useState } from "react";
import { Brain, MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { MemoryRow } from "@/types";

/**
 * Scope-agnostic memory editor shared by a Space's Memory tab and the
 * global-memories dialog: manual add, inline edit (commit on blur), delete,
 * search, a "from this chat" link for extractor-saved rows, and clear-all.
 * The host owns the on/off toggle and the store calls — this component only
 * renders rows and forwards intents.
 */
export function MemoryList({
  memories,
  enabled,
  emptyText,
  onAdd,
  onUpdate,
  onRemove,
  onOpenChat,
}: {
  memories: MemoryRow[];
  /** Gates manual adds — a disabled scope doesn't accumulate new rows. */
  enabled: boolean;
  emptyText: string;
  onAdd: (content: string) => Promise<unknown>;
  onUpdate: (id: string, content: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  /** Navigate to the chat a memory was extracted from. */
  onOpenChat: (sessionId: string) => void;
}) {
  const { confirm } = useConfirm();
  const sessions = useChatStore((s) => s.sessions);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Title lookup for the "from chat" link. A memory whose source chat was
  // deleted since just shows no link — the row itself is still valid.
  const sessionTitles = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.title])),
    [sessions],
  );

  // Newest first — the rows most likely to need a look are the ones the
  // extractor just wrote.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? memories.filter((m) => m.content.toLowerCase().includes(q))
      : memories;
    return [...rows].sort((a, b) => b.created_at - a.created_at);
  }, [memories, query]);

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await onAdd(trimmed);
      setDraft("");
    } catch {
      // Already surfaced via the call-site toast. Swallow here (so the
      // rejection doesn't double-report through the global net) and keep
      // the draft so the text the user typed isn't lost with the failure.
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (m: MemoryRow) => {
    setEditingId(m.id);
    setEditVal(m.content);
  };

  const commitEdit = async () => {
    if (!editingId) return;
    const trimmed = editVal.trim();
    const original = memories.find((m) => m.id === editingId);
    if (trimmed && original && trimmed !== original.content) {
      try {
        await onUpdate(editingId, trimmed);
      } catch {
        // Already surfaced via the call-site toast. Stay in edit mode with
        // the draft intact so the user can retry (or Escape to discard) —
        // exiting here would silently throw the edit away.
        return;
      }
    }
    setEditingId(null);
    setEditVal("");
  };

  const clearAll = async () => {
    const ok = await confirm({
      title: "Delete all memories?",
      body: `${memories.length} ${memories.length === 1 ? "memory" : "memories"} will be removed. This can't be undone.`,
      confirmLabel: "Delete all",
      destructive: true,
    });
    if (!ok) return;
    setClearing(true);
    try {
      // Sequential on purpose: each removal updates the store, and a failure
      // mid-way leaves the survivors listed rather than half-vanished.
      for (const m of memories) await onRemove(m.id);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Manual add — gated behind the scope's toggle so a disabled scope
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
            disabled={!enabled || adding}
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
            disabled={!enabled || adding || !draft.trim()}
            onClick={() => void handleAdd()}
            className="rounded-xl"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>

      {memories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/10 px-6 py-10 text-center">
          <Brain className="mx-auto mb-3 h-6 w-6 text-foreground/35" />
          <p className="text-sm text-foreground/55">{emptyText}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/40" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${memories.length} ${memories.length === 1 ? "memory" : "memories"}…`}
                className="h-9 rounded-xl border-foreground/10 bg-foreground/[0.03] pl-9"
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={clearing}
              onClick={() => void clearAll()}
              className="rounded-xl text-foreground/55 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear all
            </Button>
          </div>

          {visible.length === 0 ? (
            <p className="px-1 text-sm text-foreground/55">
              No memories match "{query.trim()}".
            </p>
          ) : (
            <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.02]">
              {visible.map((m) => {
                const sourceTitle = m.source_session_id
                  ? sessionTitles.get(m.source_session_id)
                  : undefined;
                return (
                  <li
                    key={m.id}
                    className="group flex items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-foreground/[0.04]"
                  >
                    <Brain className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40" />
                    <div className="min-w-0 flex-1">
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
                          className="min-h-[40px] w-full rounded-md border-foreground/10 bg-foreground/[0.03] text-sm"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(m)}
                          className="w-full cursor-text text-left text-foreground/85"
                          title="Click to edit"
                        >
                          {m.content}
                        </button>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground/45">
                        <span>{formatDate(m.created_at)}</span>
                        {m.source_session_id && sourceTitle !== undefined && (
                          <button
                            type="button"
                            onClick={() => onOpenChat(m.source_session_id!)}
                            className={cn(
                              "inline-flex min-w-0 items-center gap-1 hover:text-foreground/80",
                            )}
                            title="Open the chat this was saved from"
                          >
                            <MessageSquare className="h-3 w-3 shrink-0" />
                            <span className="truncate">{sourceTitle || "Untitled chat"}</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => void onRemove(m.id)}
                      aria-label="Delete memory"
                      className="shrink-0 rounded-md p-1 text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
