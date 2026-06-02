import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { PaletteEntry } from "@/lib/commands/parser";

interface CommandPaletteProps {
  /** Filtered candidate list. The composer owns the matcher so it can also
   *  decide whether to mount the palette at all — we just render. */
  entries: PaletteEntry[];
  /** Highlighted row. Driven by the composer's textarea keydown handler so
   *  the caret never leaves the input field. */
  highlightIndex: number;
  onHighlightChange: (index: number) => void;
  onSelect: (entry: PaletteEntry) => void;
}

/** Floating autocomplete drop-up anchored above ChatInput. Pure presentation —
 *  keyboard handling lives on the textarea so the caret stays put as the
 *  user navigates entries. */
export function CommandPalette({
  entries,
  highlightIndex,
  onHighlightChange,
  onSelect,
}: CommandPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible when arrow-keys push past the viewport.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${highlightIndex}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  if (entries.length === 0) return null;

  return (
    <div
      // Anchored to the composer's outer wrapper. Positioned just above the
      // glass shell with a small gap so the rounded edges visually separate.
      className="absolute bottom-full left-0 right-0 z-30 mb-2"
      // mousedown on the popup must not steal focus from the textarea;
      // otherwise typing pauses after each click.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        ref={listRef}
        role="listbox"
        className={cn(
          "mx-auto w-full max-w-3xl",
          "max-h-[260px] overflow-y-auto rounded-2xl border border-foreground/10",
          "bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-xl",
        )}
      >
        {entries.map((entry, i) => (
          <button
            key={entry.display + ":" + i}
            type="button"
            role="option"
            aria-selected={i === highlightIndex}
            data-palette-index={i}
            onMouseEnter={() => onHighlightChange(i)}
            onClick={() => onSelect(entry)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
              i === highlightIndex
                ? "bg-foreground/10 text-foreground"
                : "text-foreground/85 hover:bg-foreground/[0.06]",
            )}
          >
            <span className="font-mono text-[13px] text-foreground">
              {entry.display}
            </span>
            <span className="ml-auto truncate text-xs text-foreground/55">
              {entry.description}
            </span>
          </button>
        ))}
        <div className="mt-1 border-t border-foreground/10 px-3 py-1.5 text-[11px] text-foreground/40">
          <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
          <kbd className="font-mono">Tab</kbd> /{" "}
          <kbd className="font-mono">Enter</kbd> select ·{" "}
          <kbd className="font-mono">Esc</kbd> close
        </div>
      </div>
    </div>
  );
}
