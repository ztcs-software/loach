import { useEffect, useState } from "react";
import { Minus, Square, X, Copy, Ghost, PanelLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { useChatStore } from "@/stores/chatStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSecurityStore } from "@/stores/securityStore";
import topBarLogo from "@/assets/loach-icon.png";

// Detect macOS so we can label the Ctrl/Cmd+K shortcut with the right
// modifier. The keybinding itself accepts either (see SearchBar) — this
// is purely visual.
const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform || navigator.platform,
  );

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  // Mirror App.tsx's onboarding gate so the sidebar-toggle and search
  // pill are disabled while the wizard is on screen — the wizard owns
  // the user's attention and lets them dismiss with X.
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const onboardingCompleted = useSettingsStore((s) => s.onboarding_completed);
  const onboardingActive = settingsHydrated && !onboardingCompleted;
  // Mirror App.tsx's lock gate (`showLock`). While the lock screen owns
  // the surface, the sidebar toggle / search pill / Private Chat button
  // are HIDDEN rather than disabled: the surfaces they operate don't
  // exist behind the lock, and a greyed-out "Search chats, spaces,
  // snippets…" pill both looks broken and advertises what a locked app
  // contains. Window controls stay, so min/max/close keep working.
  const securityHydrated = useSecurityStore((s) => s.hydrated);
  const securityConfigured = useSecurityStore((s) => s.status.configured);
  const unlocked = useSecurityStore((s) => s.unlocked);
  const appLocked = securityHydrated && securityConfigured && !unlocked;
  // Private Chat takes over the whole surface below the title bar. The
  // sidebar toggle and global search both interact with regular,
  // SQLite-backed chats — clicking them while in private mode would either
  // reveal the regular sidebar behind the overlay or surface persisted
  // chat content through the search palette. Disable both for the duration
  // of the private session.
  const privateChatOpen = usePrivateChatStore((s) => s.open);
  const topBarLocked = onboardingActive || privateChatOpen;

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        const max = await w.isMaximized().catch(() => false);
        if (!cancelled) setIsMaximized(max);
        const u = await w.onResized(async () => {
          try {
            setIsMaximized(await w.isMaximized());
          } catch {
            /* ignore */
          }
        });
        if (cancelled) u();
        else unlisten = u;
      } catch {
        /* not in tauri */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const callWindow = async (method: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      await w[method]();
    } catch {
      /* ignore */
    }
  };
  const minimize = () => callWindow("minimize");
  const toggleMax = () => callWindow("toggleMaximize");
  const close = () => callWindow("close");

  // Open Private Chat. Per the "pause regular while private" decision, we
  // first cancel whichever regular chat (if any) is currently streaming so
  // it doesn't keep generating tokens into the SQLite-backed transcript
  // while the user is having an ephemeral conversation. The store is
  // intentionally agnostic of `chatStore`, so this orchestration lives at
  // the entry point.
  const openPrivateChat = () => {
    const chat = useChatStore.getState();
    const streamingId = chat.streamingSessionId;
    if (streamingId) {
      void chat.cancelForSession(streamingId);
    }
    usePrivateChatStore.getState().setOpen(true);
  };

  return (
    <div
      data-tauri-drag-region
      className="relative z-[70] flex h-9 items-center gap-2 border-b border-foreground/8 bg-foreground/[0.03] pl-1.5 pr-0 select-none backdrop-blur-2xl"
    >
      {/* Sidebar collapse/expand toggle. Lives at the leftmost slot of the
          window's title bar so the user always knows where to find it,
          regardless of which canvas surface (chat / Spaces / Snippets /
          Models / Space detail) is active.

          Single static icon + tooltip-flips for the affordance — the same
          convention Linear / Notion / Slack use. The button breaks out of
          the surrounding `data-tauri-drag-region` automatically (Tauri
          excludes interactive descendants), so click works without
          fighting the drag-and-double-click-to-maximize behaviour. */}
      {!appLocked && (
        <button
          type="button"
          onClick={toggleSidebar}
          disabled={topBarLocked}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
      )}

      {/* App identity — Loach mark + wordmark + version. The mark uses a
          dedicated top-bar asset (src/assets/loach-icon.png) imported
          inline; other surfaces (onboarding, settings) keep using the
          shared Logo component. The version sits next to the wordmark in a
          muted monospace tone so it reads as metadata, not branding.
          pointer-events-none keeps the drag region underneath intact
          (drag + double-click-to-maximize keep working over the brand). */}
      <div className="flex shrink-0 items-baseline gap-1.5 pointer-events-none pl-1">
        <img
          src={topBarLogo}
          alt=""
          aria-hidden
          width={14}
          height={14}
          draggable={false}
          className="inline-block self-center"
        />
        <span className="text-xs font-medium tracking-wide text-foreground/80">Loach</span>
        <span className="font-mono text-[10px] text-foreground/45" aria-label={`version ${__APP_VERSION__}`}>
          v{__APP_VERSION__}
        </span>
      </div>

      {/* Center spacer — pure drag region. The flex-1 here keeps the title
          bar drag-and-double-click-to-maximize working across the gaps on
          either side of the centered search pill below. */}
      <div className="min-w-0 flex-1" />

      {/* Centered search pill — absolutely positioned so it sits in the
          true horizontal middle of the window regardless of how wide the
          left (brand) or right (window controls) groups are. The wrapper
          is pointer-events-none so the underlying drag region still works
          in the empty space around the pill; the button itself re-enables
          pointer events. Click dispatches the same `loach:focus-search`
          event the Cmd/Ctrl+K shortcut uses, so the palette overlay
          (`SearchBar`) stays the single source of truth for search UI. */}
      {!appLocked && (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("loach:focus-search"))}
            disabled={topBarLocked}
            aria-label="Search"
            title="Search"
            className="pointer-events-auto inline-flex h-7 w-72 items-center gap-2 rounded-md border border-foreground/[0.08] bg-foreground/[0.04] px-2.5 text-foreground/55 transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left text-xs">
              Search chats, spaces, snippets…
            </span>
            <kbd className="rounded border border-foreground/10 bg-foreground/[0.05] px-1 py-px font-mono text-[10px] tracking-wider text-foreground/40">
              {isMac ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
        </div>
      )}

      <div className="min-w-0 flex-1" />

      {/* Right — Private Chat trigger, then window controls. The Private
          Chat button sits immediately to the left of the OS-style
          minimize/maximize/close cluster with a small margin so it reads
          as a related-but-separate action, not part of the window
          chrome itself. Disabled during onboarding for the same reason
          the sidebar toggle and search pill are disabled — the wizard
          owns the user's attention. */}
      {!appLocked && (
        <div className="flex shrink-0 items-center pr-2">
          <button
            type="button"
            onClick={openPrivateChat}
            disabled={topBarLocked}
            aria-label="Open Private Chat"
            title={
              privateChatOpen
                ? "Private Chat is already open"
                : "Private Chat — temporary, nothing stored"
            }
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Ghost className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex shrink-0 items-center">
        <TitleButton onClick={minimize} ariaLabel="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </TitleButton>
        <TitleButton
          onClick={toggleMax}
          ariaLabel={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <Copy className="h-3.5 w-3.5 rotate-180" />
          ) : (
            <Square className="h-3 w-3" />
          )}
        </TitleButton>
        <TitleButton
          onClick={close}
          ariaLabel="Close"
          className="hover:bg-destructive hover:text-destructive-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </TitleButton>
      </div>
    </div>
  );
}

function TitleButton({
  children,
  onClick,
  ariaLabel,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 w-11 items-center justify-center text-foreground/55 hover:bg-foreground/10 hover:text-foreground transition-colors",
        className,
      )}
    >
      {children}
    </button>
  );
}
