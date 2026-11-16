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
  /** The listbox's id; option `i` is `${listId}-${i}`. The composer points
   *  `aria-controls` / `aria-activedescendant` at them. */
  listId: string;
}

/** Floating autocomplete drop-up anchored above ChatInput. Pure presentation —
 *  keyboard handling lives on the textarea so the caret stays put as the
 *  user navigates entries. */
export function CommandPalette({
  entries,
  highlightIndex,
  onHighlightChange,
  onSelect,
  listId,
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

  // Group headers, reusing the registry's `group` labels (the same ones the
  // /help dialog sections on). Entries arrive in registry order, so groups
  // are contiguous and a header renders wherever the group changes. When
  // the filter has narrowed to a single group (or to one command's
  // sub-entries) a lone header is pure noise, so headers only appear once
  // two or more groups are on screen.
  const groupOf = (e: PaletteEntry) => e.groupOverride ?? e.cmd.group ?? "Other";
  const groups: { name: string; items: { entry: PaletteEntry; i: number }[] }[] = [];
  entries.forEach((entry, i) => {
    const last = groups.at(-1);
    if (last?.name === groupOf(entry)) last.items.push({ entry, i });
    else groups.push({ name: groupOf(entry), items: [{ entry, i }] });
  });
  const showHeaders = groups.length > 1;

  const option = ({ entry, i }: { entry: PaletteEntry; i: number }) => (
    <button
      key={entry.display + ":" + i}
      type="button"
      role="option"
      id={`${listId}-${i}`}
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
  );

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
        className={cn(
          "mx-auto w-full max-w-3xl rounded-2xl border border-foreground/10",
          "bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-xl",
        )}
      >
        {/* Options and labelled groups only: a header or the key hint
            inside a listbox is read as part of it. */}
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="max-h-[260px] overflow-y-auto"
        >
          {showHeaders
            ? groups.map((g, gi) => (
                <div key={g.name + ":" + gi} role="group" aria-label={g.name}>
                  <div
                    aria-hidden
                    className={cn(
                      "px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/40",
                      gi === 0 ? "pt-1.5" : "pt-2.5",
                    )}
                  >
                    {g.name}
                  </div>
                  {g.items.map(option)}
                </div>
              ))
            : groups.flatMap((g) => g.items).map(option)}
        </div>
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
