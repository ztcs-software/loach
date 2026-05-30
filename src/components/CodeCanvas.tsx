import { useMemo, useState } from "react";
import { Check, Copy, Download, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeView } from "./CodeView";
import {
  useCanvasStore,
  clampCanvasWidth,
  CANVAS_MIN_WIDTH,
} from "@/stores/canvasStore";
import { useCodeWindowStore } from "@/stores/codeWindowStore";
import { useChatStore } from "@/stores/chatStore";
import { lastCodeBlock } from "@/lib/codeBlocks";
import { preprocessTex } from "./Markdown";
import { openCodeWindow } from "@/lib/tauri";
import { saveCodeToFile, defaultFilename } from "@/lib/codeExport";
import { cn } from "@/lib/utils";

/**
 * Right-side code canvas — opens via "Open in canvas" on any inline
 * `CodeBlock`, or from an attachment chip.
 *
 * Three behaviours layered on the original read-only viewer:
 *  - horizontally resizable via a left-edge drag handle (width persisted in
 *    `canvasStore`);
 *  - live: when opened on a still-streaming code block it mirrors that block
 *    as it generates, by re-deriving from the bound message in `chatStore`;
 *  - poppable into a separate native OS window ("Open in window").
 *
 * Mutually exclusive with `ParameterPanel` (App.tsx swaps which one renders
 * in the right slot).
 */
export function CodeCanvas() {
  const isOpen = useCanvasStore((s) => s.isOpen);
  const code = useCanvasStore((s) => s.code);
  const language = useCanvasStore((s) => s.language);
  const title = useCanvasStore((s) => s.title);
  const name = useCanvasStore((s) => s.name);
  const binding = useCanvasStore((s) => s.binding);
  const width = useCanvasStore((s) => s.width);
  const close = useCanvasStore((s) => s.close);
  const setWidth = useCanvasStore((s) => s.setWidth);

  // Live source: the bound message's current content (null when not bound or
  // the message is gone). A primitive selector so we only re-render when the
  // text actually changes.
  const liveContent = useChatStore((s) =>
    binding
      ? s.messages[binding.sessionId]?.find((m) => m.id === binding.messageId)
          ?.content ?? null
      : null,
  );

  const [copied, setCopied] = useState(false);
  // Transient width while dragging the resize handle — committed (and
  // persisted) to the store on pointer-up so we don't write localStorage on
  // every move.
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  // When bound to a live message, re-extract its last fenced block so the
  // canvas tracks the streaming code. Falls back to the snapshot the canvas
  // was opened with (attachments, completed blocks, or a deleted source).
  const live = useMemo(
    () =>
      binding && liveContent != null
        ? lastCodeBlock(preprocessTex(liveContent))
        : null,
    [binding, liveContent],
  );
  const displayCode = live ? live.code : code;
  const displayLanguage = live ? live.language : language;

  if (!isOpen) return null;

  // Plain text and "no language" both render as the text variant — same as
  // the inline code block toolbar already does.
  const isText =
    !displayLanguage ||
    displayLanguage === "text" ||
    displayLanguage === "plain" ||
    displayLanguage === "plaintext" ||
    displayLanguage === "txt";

  const heading = title?.trim() || (isText ? "Text canvas" : "Code Canvas");
  const badgeLabel = isText ? "Text" : displayLanguage;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const onExport = () => {
    void saveCodeToFile(
      displayCode,
      displayLanguage,
      name ?? defaultFilename(displayLanguage),
    );
  };

  const onOpenWindow = async () => {
    const label = await openCodeWindow({
      code: displayCode,
      language: displayLanguage,
      title: heading,
      dark: document.documentElement.classList.contains("dark"),
    });
    // Register so the bridge streams updates when bound; static pop-outs pass
    // a null binding and simply show their snapshot.
    if (label) {
      useCodeWindowStore.getState().register(label, binding, displayCode);
    }
  };

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let current = startWidth;
    const onMove = (ev: PointerEvent) => {
      // Canvas hugs the right edge, so dragging the handle left widens it.
      current = clampCanvasWidth(startWidth + (startX - ev.clientX));
      setDragWidth(current);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      // Commit once (persists to localStorage); drop the transient width.
      setWidth(current);
      setDragWidth(null);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <aside
      style={{ width: dragWidth ?? width, minWidth: CANVAS_MIN_WIDTH }}
      className={cn(
        "relative flex h-full flex-col overflow-hidden border-l border-foreground/[0.06]",
        // Solid theme-aware fill — see the original note: a flat surface keeps
        // the canvas from reading as two stacked panels under the dark
        // syntax-highlight slab.
        "bg-background",
        // Neutralise github-dark.css's nested padding/background on the code so
        // the gutter lines up and the code blends into the canvas surface.
        "[&_.hljs]:bg-transparent [&_pre_code.hljs]:bg-transparent [&_pre_code.hljs]:p-0",
      )}
    >
      {/* Left-edge resize handle. A hairline that thickens on hover; the wide
          hit area makes it easy to grab without a visible bar. */}
      <div
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize canvas"
        className="group absolute left-0 top-0 z-30 h-full w-1.5 -translate-x-1/2 cursor-col-resize"
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-primary/40" />
      </div>

      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-foreground/[0.06] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={close}
            aria-label="Close canvas"
            title="Close canvas"
            className="h-7 w-7 rounded-md text-foreground/55 hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
          <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground/85">
            {heading}
          </h2>
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-foreground/55">
            {badgeLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onOpenWindow()}
            className="h-7 gap-1 rounded-md px-2 text-[11px] text-foreground/65 hover:bg-foreground/10 hover:text-foreground"
            title="Open in a separate window"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Window
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onCopy()}
            className="h-7 gap-1 rounded-md px-2 text-[11px] text-foreground/65 hover:bg-foreground/10 hover:text-foreground"
            title="Copy code"
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
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onExport}
            className="h-7 gap-1 rounded-md px-2 text-[11px] text-foreground/65 hover:bg-foreground/10 hover:text-foreground"
            title={`Export to .${displayLanguage ?? "txt"} file`}
          >
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        </div>
      </header>

      <CodeView code={displayCode} language={displayLanguage} />
    </aside>
  );
}
