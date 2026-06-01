import { useEffect, useState } from "react";
import { Check, Copy, Download, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { CodeView } from "./CodeView";
import { getCodeWindowPayload } from "@/lib/tauri";
import { saveCodeToFile, defaultFilename } from "@/lib/codeExport";
import { cn } from "@/lib/utils";

/**
 * Standalone code view shown in a popped-out OS window. main.tsx routes here
 * (instead of the full app) when the window label is a `code-*` pop-out.
 *
 * The window is created with decorations off (see `open_code_window`), so this
 * component owns the entire chrome: a custom title bar matching the app's
 * `TitleBar` — draggable, with the same minimize/maximize/close controls —
 * plus the code-specific Copy/Export actions and a line-numbered `CodeView`.
 *
 * Lifecycle:
 *  - pulls its one-shot initial payload from the Rust-side stash keyed by its
 *    own window label;
 *  - listens for `code-window:update` events the main window streams while the
 *    source block is still generating (live pop-outs);
 *  - emits `code-window:closed` on unload so the main window prunes it from
 *    the streaming registry.
 */
export function CodeWindow() {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState<string | null>(null);
  const [title, setTitle] = useState("Code");
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const label = getCurrentWindow().label;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void getCodeWindowPayload(label)
      .then((payload) => {
        if (cancelled) return;
        if (payload) {
          setCode(payload.code);
          setLanguage(payload.language);
          if (payload.title) setTitle(payload.title);
          document.documentElement.classList.toggle("dark", payload.dark);
        }
      })
      .catch(() => {
        /* surface an empty (but not stuck-loading) window instead of hanging */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    void listen<{ code: string; language: string | null }>(
      "code-window:update",
      (e) => {
        setCode(e.payload.code);
        setLanguage(e.payload.language);
      },
    ).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    // Tell the main window to stop streaming to us when the OS window closes.
    // Only on real unload — NOT in the effect cleanup, since React StrictMode
    // (dev) tears the effect down and back up once on mount, which would
    // otherwise unregister a window that's still very much open.
    const notifyClosed = () => {
      void emit("code-window:closed", { label });
    };
    window.addEventListener("beforeunload", notifyClosed);

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.removeEventListener("beforeunload", notifyClosed);
    };
  }, []);

  // Keep the maximize/restore icon in sync with the window state, mirroring the
  // main `TitleBar`. The pop-out starts un-maximized (centered, fixed size), so
  // the initial read just confirms that and resize events flip it thereafter.
  useEffect(() => {
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void w
      .isMaximized()
      .then((m) => {
        if (!cancelled) setIsMaximized(m);
      })
      .catch(() => {
        /* ignore */
      });
    void w
      .onResized(async () => {
        try {
          setIsMaximized(await w.isMaximized());
        } catch {
          /* ignore */
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const isText =
    !language ||
    language === "text" ||
    language === "plain" ||
    language === "plaintext" ||
    language === "txt";

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const onExport = () => {
    void saveCodeToFile(code, language, defaultFilename(language));
  };

  const minimize = () => void getCurrentWindow().minimize();
  const toggleMax = () => void getCurrentWindow().toggleMaximize();
  const close = () => void getCurrentWindow().close();

  return (
    <div
      className={cn(
        "flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground",
        "[&_.hljs]:bg-transparent [&_pre_code.hljs]:bg-transparent [&_pre_code.hljs]:p-0",
      )}
    >
      {/* Custom title bar — same chrome as the main window's `TitleBar`. The
          bar itself is a Tauri drag region; interactive descendants (the
          action and window-control buttons) are auto-excluded from dragging,
          and the title/badge group is pointer-events-none so a drag started
          over it still moves the window. */}
      <div
        data-tauri-drag-region
        className="relative z-[70] flex h-9 shrink-0 items-center gap-2 border-b border-foreground/8 bg-foreground/[0.03] pl-3 pr-0 select-none backdrop-blur-2xl"
      >
        <div className="pointer-events-none flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-xs font-medium tracking-wide text-foreground/80">
            {title}
          </h1>
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground/55">
            {isText ? "Text" : language}
          </span>
        </div>

        <div className="min-w-0 flex-1" />

        <div className="flex shrink-0 items-center gap-1 pr-1">
          <button
            type="button"
            onClick={() => void onCopy()}
            title="Copy code"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-foreground/65 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onExport}
            title={`Export to .${language ?? "txt"} file`}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-foreground/65 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" /> Export
          </button>
        </div>

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

      {loaded || code ? (
        <CodeView code={code} language={language} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-foreground/40">
          Loading…
        </div>
      )}
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
