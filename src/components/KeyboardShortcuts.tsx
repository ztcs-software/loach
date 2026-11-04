import { useEffect, useState } from "react";
import { ShortcutListDialog } from "@/components/ShortcutListDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useModelsStore } from "@/stores/modelsStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSecurityStore } from "@/stores/securityStore";
import { deleteChatConfirm } from "@/lib/confirmations";
import {
  matches,
  modalDialogOpen,
  SHORTCUTS,
  type ShortcutAction,
} from "@/lib/shortcuts";

/**
 * App-wide keyboard shortcut handler. Mounts once near the root and owns a
 * single window-level keydown listener that dispatches every shortcut
 * declared in `SHORTCUTS`. Co-located logic keeps the shortcut table
 * (`src/lib/shortcuts.ts`) as the single source of truth — adding a new
 * binding means adding an entry there + a case below, nothing else.
 *
 * Gated surfaces — shortcuts are suppressed when any of these own the
 * screen, mirroring the same gates `TitleBar` uses:
 *   - the security probe still pending (App renders only the background)
 *   - lock screen (security configured + still locked)
 *   - onboarding (not yet completed)
 *   - private chat (owns the whole UI below the title bar)
 *   - a modal dialog, the Ctrl/Cmd+K palette included
 *
 * `lock-now` is the one exception: it runs through the last three, since the
 * point of a panic key is that it works wherever you are.
 *
 * The Cmd/Ctrl-K palette has its OWN listener inside `SearchBar` that
 * predates this component; we intentionally don't double-handle it here.
 * Same for `loach:open-chat-search` (the existing in-chat finder), which
 * we just dispatch via the global handler instead of re-implementing the
 * overlay.
 */

/** Is the chat view what's on screen? A Space's page, a model's page or
 *  another sidebar tab (Library, say) hides the open chat. */
function chatOnScreen(): boolean {
  return (
    !useSpaceStore.getState().viewingSpaceId &&
    !useModelsStore.getState().viewingModel &&
    useUIStore.getState().sidebarTab === "chats"
  );
}

export function KeyboardShortcuts() {
  const { confirm } = useConfirm();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Find the first spec that matches the event. `matches` is strict on
      // Shift/Alt so Ctrl+S and Ctrl+Shift+S can't collide. Resolved BEFORE
      // the gate below because `lock-now` is exempt from part of it.
      const spec = SHORTCUTS.find((s) => matches(s, e));
      if (!spec) return;

      // `global-search` is already owned by SearchBar's own listener —
      // skip it here so we don't fight that handler for `preventDefault`.
      if (spec.action === "global-search") return;

      // Gate. Read store state directly inside the handler so we never get
      // stale snapshots and don't have to re-bind the listener on every
      // gate-state change.
      const sec = useSecurityStore.getState();
      const settings = useSettingsStore.getState();
      const priv = usePrivateChatStore.getState();
      const onboardingActive =
        settings.hydrated && !settings.loadError && !settings.onboarding_completed;
      // Until the security probe lands the lock isn't known: a configured
      // lock still reads as unlocked, and Ctrl+N made a chat behind the blank
      // screen App shows meanwhile. Nothing to lock yet either.
      const probing = !sec.hydrated;
      const locked = sec.status.configured && !sec.unlocked;
      // `lock-now` deliberately survives the onboarding / private-chat gates:
      // a panic key that goes dead on the most sensitive surface in the app
      // (an off-the-record chat) is worse than not shipping one. It stays
      // gated on `locked` because re-locking a locked app does nothing.
      //
      // The rest wait for an open dialog to close: they acted on the app
      // behind it — Ctrl+Shift+Backspace under the Ctrl+K palette opened the
      // delete confirm beneath it, with focus on its Delete button for the
      // next Enter.
      const panic = spec.action === "lock-now";
      if (
        probing ||
        locked ||
        ((onboardingActive || priv.open || modalDialogOpen()) && !panic)
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      void run(spec.action);
    };

    const run = async (action: ShortcutAction) => {
      switch (action) {
        case "new-chat": {
          const chat = useChatStore.getState();
          useSpaceStore.getState().setViewingSpace(null);
          useModelsStore.getState().setViewingModel(null);
          useUIStore.getState().setSidebarTab("chats");
          await chat.newSession({ spaceId: null });
          return;
        }

        case "find-in-chat": {
          // No-op when no chat is open — the in-chat finder requires
          // messages to search. Mirrors the ChatHeader menu's behaviour.
          const chat = useChatStore.getState();
          if (!chat.activeSessionId) return;
          window.dispatchEvent(new CustomEvent("loach:open-chat-search"));
          return;
        }

        case "open-uploads": {
          // Only meaningful when the composer is mounted (i.e. a chat is
          // open). ChatInput owns its file-input ref, so we ask it to
          // open the picker via a custom event rather than reaching
          // across the tree for the ref.
          const chat = useChatStore.getState();
          if (!chat.activeSessionId) return;
          window.dispatchEvent(new CustomEvent("loach:open-file-picker"));
          return;
        }

        case "toggle-sidebar": {
          useUIStore.getState().toggleSidebar();
          return;
        }

        case "toggle-params": {
          // Right slot is mutually exclusive with the code canvas. The
          // params panel itself only renders beside an open chat, so we
          // no-op otherwise to avoid toggling a flag the user can't see take
          // effect — on a Space's, the Library's or a model's page it opened
          // nothing, yet collapsed the sidebar on a narrow window to make
          // room for it.
          const chat = useChatStore.getState();
          if (!chat.activeSessionId || !chatOnScreen()) return;
          useUIStore.getState().toggleParams();
          return;
        }

        case "delete-current-chat": {
          const chat = useChatStore.getState();
          // Only a chat that's on screen. A Space's page, a model's page or
          // another sidebar tab (Library, say) hides the open chat, and the
          // shortcut used to delete it from behind them.
          const id = chatOnScreen() ? chat.activeSessionId : null;
          if (!id) return;
          const session = chat.sessions.find((s) => s.id === id);
          if (!session) return;
          const ok = await confirm(deleteChatConfirm(session.title));
          if (ok) void chat.remove(id);
          return;
        }

        case "lock-now": {
          // No-op unless a lock is configured — see `securityStore.lock`.
          useSecurityStore.getState().lock();
          return;
        }

        case "show-shortcuts": {
          setShortcutsOpen((v) => !v);
          return;
        }
      }
    };

    // Capture phase so we beat any inner handlers (textarea, contentEditable
    // inside markdown, etc.). The shortcuts are app-level, not field-level.
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [confirm]);

  return (
    <ShortcutListDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
  );
}
