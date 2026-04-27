import { useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { SearchBar } from "@/components/SearchBar";
import { Logo } from "@/components/Logo";

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

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
      className="relative z-20 flex h-9 items-center gap-3 border-b border-foreground/8 bg-foreground/[0.03] px-3 select-none backdrop-blur-2xl"
    >
      {/* App identity — Loach mark + wordmark. The mark is a theme-aware
          SVG (black in light mode, orange in dark) rendered by the Logo
          component, which uses CSS-only swapping to avoid a JS re-render on
          theme change. pointer-events-none keeps the drag region underneath
          intact (drag + double-click-to-maximize keep working over the brand). */}
      <div className="flex shrink-0 items-center gap-1.5 pointer-events-none">
        <Logo size={14} ariaHidden />
        <span className="text-xs font-medium tracking-wide text-foreground/80">Loach</span>
      </div>

      {/* Center — global search. The outer flex spacer is pointer-events-none
          so empty gaps next to the search bar stay part of the drag region
          (drag + double-click-to-maximize keep working); the SearchBar itself
          re-enables pointer events on its own root. */}
      <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center">
        <SearchBar />
      </div>

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
