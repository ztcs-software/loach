import { useEffect, useState } from "react";
import { Minus, Square, X, Copy, PanelLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { Logo } from "@/components/Logo";
import { useUIStore } from "@/stores/uiStore";
import pkg from "../../package.json";

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

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

  const callWindow = async (method: "minimize" | "toggleMaximize" | "hide") => {
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
  const close = () => callWindow("hide");

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
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 hover:bg-foreground/10 hover:text-foreground transition-colors"
      >
        <PanelLeft className="h-3.5 w-3.5" />
      </button>

      {/* App identity — Loach mark + wordmark + version. The mark is a
          theme-aware SVG (black in light mode, orange in dark) rendered by
          the Logo component, which uses CSS-only swapping to avoid a JS
          re-render on theme change. The version sits next to the wordmark
          in a muted monospace tone so it reads as metadata, not branding.
          pointer-events-none keeps the drag region underneath intact
          (drag + double-click-to-maximize keep working over the brand). */}
      <div className="flex shrink-0 items-baseline gap-1.5 pointer-events-none pl-1">
        <Logo size={14} ariaHidden className="self-center" />
        <span className="text-xs font-medium tracking-wide text-foreground/80">Loach</span>
        <span className="font-mono text-[10px] text-foreground/45" aria-label={`version ${pkg.version}`}>
          v{pkg.version}
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
      <div className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("loach:focus-search"))}
          aria-label="Search"
          title="Search"
          className="pointer-events-auto inline-flex h-7 w-72 items-center gap-2 rounded-md border border-foreground/[0.08] bg-foreground/[0.04] px-2.5 text-foreground/55 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left text-xs">
            Search chats, spaces, snippets…
          </span>
          <kbd className="rounded border border-foreground/10 bg-foreground/[0.05] px-1 py-px font-mono text-[10px] tracking-wider text-foreground/40">
            ⌘K
          </kbd>
        </button>
      </div>

      <div className="min-w-0 flex-1" />

      {/* Right — window controls. */}
      <div className="flex shrink-0 items-center">
        <TitleButton onClick={minimize} ariaLabel="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </TitleButton>
        <TitleButton onClick={toggleMax} ariaLabel="Maximize">
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
