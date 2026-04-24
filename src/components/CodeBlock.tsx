import { useState } from "react";
import { Check, Copy } from "lucide-react";
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
 * for separation. Highlight.js still renders its github-dark palette
 * over the top — most of its colours have enough chroma to remain
 * legible against the warmer backdrop.
 */
export function CodeBlock({ className, children, raw, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
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
          "flex items-center justify-between px-3 py-1.5",
          "border-b border-foreground/[0.08] bg-foreground/[0.04]",
        )}
      >
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {language || "text"}
        </span>
        <button
          onClick={onCopy}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
            "text-muted-foreground transition-colors",
            "hover:bg-foreground/10 hover:text-foreground",
          )}
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-3.5 py-3 text-[12.5px] leading-relaxed",
          "font-mono text-foreground/95",
          className,
        )}
      >
        {children}
      </pre>
    </div>
  );
}
