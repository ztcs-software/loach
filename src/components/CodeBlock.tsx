import { useMemo, useState } from "react";
import { Check, Copy, Download, PanelRight } from "lucide-react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useMarkdownSource } from "./markdownSource";
import { saveCodeToFile, defaultFilename } from "@/lib/codeExport";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
  /** Raw text to copy. Highlighted children stay decorative. */
  raw: string;
  language?: string;
}

/**
 * Highlighted code block with a small toolbar.
 *
 * The colour treatment is deliberately translucent rather than a flat
 * near-black slab: the chat surface is a glass card on a gradient mesh,
 * and a `bg-zinc-950` rectangle reads as a foreign panel pasted on top.
 * Instead we layer a subtle white wash (`foreground/[0.05]`) so the
 * block "belongs" to the bubble, then rely on a 1px hairline border
 * for separation. Highlight.js renders github-dark in dark mode and the
 * github (light) palette in light mode — the flip lives in
 * `globals.css` and is scoped on `html:not(.dark)`.
 *
 * Layout: a left gutter of line numbers + the highlighted source.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ python                       Open · Export · Copy│  ← toolbar
 *   ├─────┬────────────────────────────────────────┤
 *   │  1  │ # comment                              │
 *   │  2  │ print("Hello, world!")                 │
 *   └─────┴────────────────────────────────────────┘
 *
 * The line numbers live in their own `<pre>` next to the code so they stay
 * aligned without splitting the highlighted span tree across lines (which
 * `rehype-highlight` doesn't help with). Both blocks share the same
 * monospace font + line-height so rows line up exactly.
 */
export function CodeBlock({ className, children, raw, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const openCanvas = useCanvasStore((s) => s.open);
  const openCanvasLive = useCanvasStore((s) => s.openLive);
  const source = useMarkdownSource();

  const lineCount = useMemo(() => {
    if (!raw) return 1;
    // Trailing newlines would render as phantom blank rows; trim them off
    // for the gutter (the original `raw` is preserved for copy / export).
    return raw.replace(/\n+$/, "").split("\n").length;
  }, [raw]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const onExport = () => {
    void saveCodeToFile(raw, language, defaultFilename(language));
  };

  const onOpenCanvas = () => {
    // Bind the canvas live only when this block is the one still streaming —
    // i.e. the last fenced block of a message that's actively generating.
    // Earlier blocks are already complete, so a static snapshot is correct
    // (and avoids the canvas jumping to a different, growing block).
    const isStreamingTail =
      source?.streaming &&
      source.lastBlockRaw != null &&
      raw.trimEnd() === source.lastBlockRaw.trimEnd();
    if (isStreamingTail && source) {
      openCanvasLive({
        sessionId: source.sessionId,
        messageId: source.messageId,
        code: raw,
        language: language ?? null,
      });
    } else {
      openCanvas({ code: raw, language: language ?? null });
    }
  };

  return (
    <div
      className={cn(
        "group relative my-3 overflow-hidden rounded-lg",
        "border border-foreground/10 bg-foreground/[0.05]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 px-3 py-1.5",
          "border-b border-foreground/[0.08] bg-foreground/[0.04]",
        )}
      >
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {language || "text"}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarButton
            onClick={onOpenCanvas}
            label="Open in canvas"
            icon={<PanelRight className="h-3 w-3" />}
          >
            Open
          </ToolbarButton>
          <ToolbarButton
            onClick={onExport}
            label={`Export to .${language ?? "txt"} file`}
            icon={<Download className="h-3 w-3" />}
          >
            Export
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void onCopy()}
            label="Copy code"
            icon={
              copied ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )
            }
          >
            {copied ? "Copied" : "Copy"}
          </ToolbarButton>
        </div>
      </div>

      <div className="flex font-mono text-[12.5px] leading-relaxed">
        <pre
          aria-hidden
          // /40 (not /30): the gutter still reads as secondary next to the
          // code's /95, but /30 remaps to 0.48 alpha in globals.css, which
          // is 3.3:1 on the light code surface.
          className="select-none px-3 py-3 text-right tabular-nums text-foreground/40"
        >
          {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
        </pre>
        <pre
          className={cn(
            "flex-1 overflow-x-auto px-3.5 py-3 text-foreground/95",
            className,
          )}
        >
          {children}
        </pre>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  label,
  icon,
  children,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
        "text-muted-foreground transition-colors",
        "hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
