import { useMemo } from "react";
import hljs from "highlight.js/lib/common";

/**
 * Shared syntax-highlighted code body — a left gutter of line numbers next to
 * the highlighted source, with both axes of scrolling owned by the outer
 * container so the horizontal scrollbar lands at the bottom of the viewport.
 *
 * Used by both the in-app `CodeCanvas` and the popped-out `CodeWindow` so the
 * two surfaces render identically. Parents own their own header chrome.
 */
export function CodeView({
  code,
  language,
}: {
  code: string;
  language: string | null;
}) {
  const lineCount = useMemo(() => {
    if (!code) return 1;
    // Trailing newlines would otherwise add a phantom blank line at the
    // bottom; trim them off the count specifically.
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

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex w-max min-w-full font-mono text-[12.5px] leading-[1.65]">
        <pre
          aria-hidden
          className="sticky left-0 z-10 select-none bg-background px-3 py-3 text-right tabular-nums text-foreground/30"
        >
          {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
        </pre>
        <pre className="px-3 py-3 text-foreground/95">
          <code
            className={language ? `hljs language-${language}` : "hljs"}
            // Highlight.js produces inline span markup we render straight
            // through. The HTML comes from `hljs.highlight()` which only
            // emits its own classed spans — never user-controlled tags.
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </div>
    </div>
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
