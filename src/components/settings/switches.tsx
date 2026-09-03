//! Two Settings -> General switches that carry enough of their own state and
//! copy to be worth their own file: Ollama keep-alive and UI font size.

import type { FontSize, OllamaKeepAlive } from "@/types";
import { cn } from "@/lib/utils";

/* ───────────────────────── Font-size switch ─────────────────────────
 *
 * Three-way segmented control for the global font scale. Each option
 * previews its own size in the label so users can eyeball the choice
 * without applying it. Selection writes the value to settings, where
 * `applyFontSize` flips a class on <html> and the CSS in globals.css
 * reads `--font-scale`.
 * ─────────────────────────────────────────────────────────────────── */

const FONT_SIZE_OPTIONS: { value: FontSize; label: string; previewPx: number }[] = [
  { value: "small",  label: "Small",  previewPx: 12 },
  { value: "normal", label: "Normal", previewPx: 14 },
  { value: "large",  label: "Large",  previewPx: 16 },
];

const KEEP_ALIVE_OPTIONS: { value: OllamaKeepAlive; label: string }[] = [
  { value: "5m", label: "5 min" },
  { value: "30m", label: "30 min" },
  { value: "1h", label: "1 hour" },
  { value: "-1", label: "Always" },
];



export function KeepAliveSwitch({
  value,
  onChange,
}: {
  value: OllamaKeepAlive;
  onChange: (next: OllamaKeepAlive) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Keep model loaded"
      className="mt-3 grid grid-cols-4 gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-1"
    >
      {KEEP_ALIVE_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center justify-center rounded-xl px-3 py-2 text-[12px] font-medium transition-colors",
              selected
                ? "bg-primary/10 text-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]"
                : "text-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function FontSizeSwitch({
  value,
  onChange,
}: {
  value: FontSize;
  onChange: (next: FontSize) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Font size"
      className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-1"
    >
      {FONT_SIZE_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-xl px-3 py-2.5 transition-colors",
              selected
                ? "bg-primary/10 text-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]"
                : "text-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            <span
              className="font-medium leading-none"
              style={{ fontSize: `${opt.previewPx}px` }}
            >
              Aa
            </span>
            <span className="text-[11px] text-foreground/65">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Appearance tiles ─────────────────────────
 *
 * Card-style selectors inspired by ChatGPT's appearance picker: each
 * tile shows a miniature mockup of the app rendered with the option's
 * palette, plus a check indicator + label underneath. Selected tile
 * gets a primary-coloured ring so the choice reads at a glance.
 *
 * Kept local to this file — the mini-mockup is bespoke to the Loach
 * layout (sidebar + chat column + input bar) and has no reason to
 * live elsewhere.
 * ─────────────────────────────────────────────────────────────────── */

