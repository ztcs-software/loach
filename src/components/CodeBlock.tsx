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
    <div className="group relative my-3 overflow-hidden rounded-md border border-border/60 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-border/60 bg-zinc-900/60 px-3 py-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {language || "text"}
        </span>
        <button
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className={cn("overflow-x-auto p-3 text-[12.5px] leading-relaxed", className)}>
        {children}
      </pre>
    </div>
  );
}
