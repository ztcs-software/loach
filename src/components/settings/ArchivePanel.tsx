//! Settings -> Archive: the list of archived chats and its per-row actions.
//! Self-contained apart from the callback that closes the dialog when the
//! user opens a chat from here.

import type { Session } from "@/types";
import { Archive, ArchiveRestore, Layers, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useConfirm } from "@/components/ConfirmDialog";
import { useState } from "react";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";

export function ArchivePanel({ onOpenChat }: { onOpenChat: () => void }) {
  const sessions = useChatStore((s) => s.sessions);
  const archive = useChatStore((s) => s.archive);
  const remove = useChatStore((s) => s.remove);
  const removeAllArchived = useChatStore((s) => s.removeAllArchived);
  const select = useChatStore((s) => s.selectSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const { confirm } = useConfirm();
  const [removingAll, setRemovingAll] = useState(false);

  const archived = sessions
    .filter((s) => s.archived_at != null)
    .sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));

  const handleOpen = async (id: string) => {
    setViewingSpace(null);
    await select(id);
    onOpenChat();
  };

  const handleRemoveAll = async () => {
    const count = archived.length;
    if (count === 0) return;
    const ok = await confirm({
      title: `Remove ${count} archived chat${count === 1 ? "" : "s"}?`,
      body: "This permanently deletes the archived chats and all their messages. This cannot be undone.",
      confirmLabel: "Remove all",
      destructive: true,
    });
    if (!ok) return;
    setRemovingAll(true);
    try {
      const n = await removeAllArchived();
      useToastStore.getState().push({
        kind: "info",
        title: `Removed ${n} chat${n === 1 ? "" : "s"}`,
      });
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't remove archived chats",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRemovingAll(false);
    }
  };

  if (archived.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-8 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-foreground/[0.06] text-foreground/60">
          <Archive className="h-4 w-4" />
        </div>
        <h2 className="mt-3 text-sm font-medium">Nothing archived</h2>
        <p className="mt-1 max-w-md text-[12px] text-foreground/55">
          Right-click a chat in the sidebar and choose <em>Move to archive</em>{" "}
          to stash it here without losing the history.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-foreground/55">
          {archived.length} archived chat{archived.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleRemoveAll()}
          disabled={removingAll}
          className="h-7 gap-1 rounded-lg px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          {removingAll ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Removing…
            </>
          ) : (
            <>
              <Trash2 className="h-3.5 w-3.5" />
              Remove all
            </>
          )}
        </Button>
      </div>
      <ul className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 bg-foreground/[0.03]">
        {archived.map((s) => (
          <ArchivedRow
            key={s.id}
            session={s}
            onOpen={() => void handleOpen(s.id)}
            onUnarchive={() => void archive(s.id, false)}
            onDelete={() =>
              void (async () => {
                const ok = await confirm({
                  title: "Delete this chat?",
                  body: `“${s.title || "Untitled"}” and all its messages will be permanently deleted. This cannot be undone.`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) await remove(s.id);
              })()
            }
          />
        ))}
      </ul>
    </>
  );
}

function ArchivedRow({
  session,
  onOpen,
  onUnarchive,
  onDelete,
}: {
  session: Session;
  onOpen: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const archivedOn = session.archived_at
    ? new Date(session.archived_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";

  return (
    <li
      className={cn(
        "group flex items-center gap-2 px-3 py-2.5 transition-colors",
        "hover:bg-foreground/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85">
          {session.title}
        </span>
        {session.space_id && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-foreground/55">
            <Layers className="h-2.5 w-2.5" />
            Space
          </span>
        )}
        <span className="shrink-0 text-[11px] text-foreground/40">
          {archivedOn}
        </span>
      </button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onUnarchive}
        className="h-7 gap-1 rounded-lg px-2 text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
      >
        <ArchiveRestore className="h-3.5 w-3.5" />
        Unarchive
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Archived chat actions"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onUnarchive}>
            <ArchiveRestore className="h-4 w-4" /> Unarchive
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Delete permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/* ───────────────────────── Data tab panel ─────────────────────────
 *
 * Four bulk operations live here:
 *
 *   1. Export   — dump the whole DB to a JSON file via a save dialog.
 *   2. Import   — pick a JSON dump, replace everything with its contents,
 *                 then reload the window so every store re-hydrates from
 *                 the freshly-written DB.
 *   3. Archive all — flip every live chat to archived in one shot.
 *   4. Erase    — two-mode destructive flow (user-data vs factory reset),
 *                 gated on a typed "YES" confirmation.
 *
 * The destructive actions rebuild the whole app by calling
 * `window.location.reload()` — every Zustand store derives from SQLite
 * on mount (see App.tsx's hydrate useEffect), so a reload is the
 * cheapest way to get back to a consistent state without writing a
 * bespoke rehydrate function per store.
 * ─────────────────────────────────────────────────────────────────── */

