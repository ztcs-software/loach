import { useMemo, useState } from "react";
import { Check, Copy, Download, X } from "lucide-react";
import hljs from "highlight.js/lib/common";
import { Button } from "@/components/ui/button";
import { useCanvasStore } from "@/stores/canvasStore";
import { saveCodeToFile, defaultFilename } from "@/lib/codeExport";
import { cn } from "@/lib/utils";

/**
 * Right-side code canvas — opens via "Open in canvas" on any inline
 * `CodeBlock`. Read-only for now: title, copy, export, syntax-highlighted
 * body with a left gutter of line numbers.
 *
 * Sizing rule: occupy a meaningful chunk of the right side without crushing
 * the chat. We use `clamp(360px, 42vw, 720px)` so the canvas grows on wide
 * monitors but stays compact on narrow ones — close to ChatGPT's behaviour
 * without going full-screen.
 *
 * Mutually exclusive with `ParameterPanel` (App.tsx swaps which one renders
 * in the right slot). Reopening the params drawer requires closing the
 * canvas first; the alternative — stacking both — would either need a tab
 * UI or two side rails, neither of which is worth the complexity yet.
 */
export function CodeCanvas() {
  const isOpen = useCanvasStore((s) => s.isOpen);
  const code = useCanvasStore((s) => s.code);
  const language = useCanvasStore((s) => s.language);
  const title = useCanvasStore((s) => s.title);
  const close = useCanvasStore((s) => s.close);

  const [copied, setCopied] = useState(false);

  const lineCount = useMemo(() => {
    if (!code) return 1;
    // Trailing newlines on the snippet would otherwise add a phantom blank
    // line at the bottom; trim them off the line count specifically (the
    // original `code` is preserved for copy / export).
    return code.replace(/\n+$/, "").split("\n").length;
  }, [code]);

  const highlighted = useMemo(() => {
    if (!code) return "";
    if (language) {
      const known = hljs.getLanguage(language);
      if (known) {
        try {
          return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        } catch {
          /* fall through to auto */
        }
      }
    }
    try {
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  if (!isOpen) return null;

  // Plain text and "no language" both render as the text variant — same as
  // the inline code block toolbar already does. The fenced `text`/`plain`
  // markdown hints come through verbatim from rehype-highlight, so we
  // collapse them here rather than at the call site.
  const isText =
    !language ||
    language === "text" ||
    language === "plain" ||
    language === "plaintext" ||
    language === "txt";

  const heading = title?.trim() || (isText ? "Text canvas" : "Code Canvas");
  const badgeLabel = isText ? "Text" : language;

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

  return (
    <aside
      className={cn(
        "relative flex h-full flex-col overflow-hidden border-l border-foreground/[0.06]",
        // Solid theme-aware fill instead of the translucent `glass-subtle`
        // we use elsewhere — the gradient mesh bleeding through under the
        // syntax-highlighted code (which itself ships its own dark slab via
        // `github-dark.css`) made the canvas look like two stacked surfaces.
        // A flat `bg-background` keeps the whole panel a single colour;
        // `[&_.hljs]:bg-transparent` then drops highlight.js's nested fill so
        // the code blends into the canvas instead of nesting another box.
        "bg-background",
        "[&_.hljs]:bg-transparent [&_pre_code.hljs]:bg-transparent",
        // Sized to roughly mirror ChatGPT's canvas — generous on wide
        // displays, tight (but usable) on narrow ones.
        "w-[clamp(360px,42vw,720px)]",
      )}
    >
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
            title={`Export to .${language ?? "txt"} file`}
          >
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="flex font-mono text-[12.5px] leading-[1.65]">
          <pre
            aria-hidden
            className="select-none px-3 py-3 text-right tabular-nums text-foreground/30"
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </pre>
          <pre className="flex-1 overflow-x-auto px-3 py-3 text-foreground/95">
            <code
              className={
                language ? `hljs language-${language}` : "hljs"
              }
              // Highlight.js produces inline span markup we render straight
              // through. The HTML comes from `hljs.highlight()` which only
              // emits its own classed spans — never user-controlled tags.
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          </pre>
        </div>
      </div>
    </aside>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
