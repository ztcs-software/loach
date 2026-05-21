import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { getCleanSelectionText } from "@/lib/selection";

/**
 * Floating "Copy" pill that appears next to the user's text selection when the
 * selection lives inside a message bubble (user or assistant). Mounted once at
 * the app root and driven by the document `selectionchange` event so it
 * doesn't matter which message the selection came from.
 *
 * Text extraction goes through `getCleanSelectionText` so user-prompt copies
 * come out as the exact typed slice (no block-boundary blank lines) while
 * assistant copies keep their markdown structure.
 */
export function SelectionCopyButton() {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPos(null);
        return;
      }
      const result = getCleanSelectionText();
      // Only surface the pill for in-message selections — sidebar / composer
      // selections fall through to "other" and shouldn't trigger it.
      if (
        !result ||
        (result.source !== "user-prompt" && result.source !== "assistant") ||
        !result.text.trim()
      ) {
        setPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1];
      if (!last) {
        setPos(null);
        return;
      }
      // Anchor near the trailing edge of the selection so the button feels
      // attached to where the user lifted the mouse / caret. Clamp against
      // the viewport so it never gets pushed off-screen for selections that
      // wrap to the right edge.
      const margin = 8;
      const btnW = 84;
      const btnH = 30;
      let left = last.right + 6;
      let top = last.bottom + 6;
      if (left + btnW > window.innerWidth - margin) {
        left = window.innerWidth - btnW - margin;
      }
      if (top + btnH > window.innerHeight - margin) {
        top = last.top - btnH - 6;
      }
      setText(result.text);
      setPos({ left, top });
    };

    // selectionchange fires on every caret movement; debouncing isn't needed
    // because state updates collapse anyway and the work above is cheap.
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, []);

  // Reset the "Copied" tick whenever the button is dismissed, so the next
  // selection starts fresh instead of flashing the last state.
  useEffect(() => {
    if (!pos) setCopied(false);
  }, [pos]);

  if (!pos) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch {
      // Clipboard may be unavailable in sandboxed WebViews; swallow.
    }
  };

  return (
    <button
      ref={btnRef}
      type="button"
      // Pointing-down on this prevents the click from collapsing the
      // selection before our handler reads it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleCopy}
      style={{ left: pos.left, top: pos.top }}
      className={cn(
        "fixed z-50 inline-flex items-center gap-1.5 rounded-full border border-foreground/15 bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground/85 shadow-lg backdrop-blur-md transition-colors hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-400" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </>
      )}
    </button>
  );
}
