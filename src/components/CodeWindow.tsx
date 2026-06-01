import { useEffect, useState } from "react";
import { Check, Copy, Download, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { CodeView } from "./CodeView";
import { getCodeWindowPayload } from "@/lib/tauri";
import { saveCodeToFile, defaultFilename } from "@/lib/codeExport";
import { cn } from "@/lib/utils";

/**
 * Standalone code view shown in a popped-out native OS window. main.tsx routes
 * here (instead of the full app) when the window label is a `code-*` pop-out.
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

  const onClose = () => {
    void getCurrentWindow().close();
  };

  return (
    <div
      className={cn(
        "flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground",
        "[&_.hljs]:bg-transparent [&_pre_code.hljs]:bg-transparent [&_pre_code.hljs]:p-0",
      )}
    >
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-foreground/[0.06] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground/85">
            {title}
          </h1>
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground/55">
            {isText ? "Text" : language}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
          <button
            type="button"
            onClick={onClose}
            title="Close window"
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/65 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

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
