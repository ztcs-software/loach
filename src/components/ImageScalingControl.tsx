import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  describeImageScaling,
  IMAGE_SCALING_PERCENT,
  IMAGE_SCALING_PX,
} from "@/lib/imageScaling";
import { cn } from "@/lib/utils";
import type { ImageScaling } from "@/types";

type Choice = "inherit" | "scale" | "original";

const segmentClass = (selected: boolean) =>
  cn(
    "whitespace-nowrap rounded-[10px] py-1 text-xs font-medium transition-colors",
    selected ? "bg-foreground/[0.10] text-foreground" : "text-foreground/55 hover:text-foreground",
  );

/**
 * The image-scaling control every level shares (Settings → Features and
 * → Library, a Space's Settings tab, a chat's Parameters panel): scale down
 * or send the original, and how far. With `inheritFrom` the level may leave
 * `value` null to follow `inherited`, which the "Default" option shows.
 */
export function ImageScalingControl({
  value,
  inherited,
  inheritFrom,
  onChange,
}: {
  value: ImageScaling | null;
  inherited: ImageScaling;
  /** What a null `value` follows, e.g. "the Space's setting". Omitted for
   *  the app's own level, which always has a value. */
  inheritFrom?: string;
  onChange: (next: ImageScaling | null) => void;
}) {
  const choice: Choice = value === null ? "inherit" : value.enabled ? "scale" : "original";
  const choices: { id: Choice; label: string }[] = [
    ...(inheritFrom ? [{ id: "inherit" as const, label: "Default" }] : []),
    { id: "scale", label: "Scale down" },
    { id: "original", label: "Original" },
  ];
  const pick = (next: Choice) => {
    if (next === choice) return;
    // Starting from what's in effect keeps the sizes the user already sees.
    onChange(next === "inherit" ? null : { ...(value ?? inherited), enabled: next === "scale" });
  };

  const hint =
    value === null
      ? `Uses ${inheritFrom}: ${describeImageScaling(inherited)}.`
      : !value.enabled
        ? "Images go at their original size, up to 20 MB each."
        : value.mode === "px"
          ? `Images larger than ${value.px} px on their longest side are shrunk to fit; smaller ones go as they are.`
          : `Images go at ${value.percent}% of their width and height.`;

  return (
    <div className="space-y-2.5">
      <div
        role="radiogroup"
        aria-label="Image scaling"
        className="grid rounded-xl border border-foreground/10 bg-foreground/[0.04] p-0.5"
        style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}
      >
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={choice === c.id}
            onClick={() => pick(c.id)}
            // Narrow padding: three options fit the chat's Parameters panel.
            className={cn(segmentClass(choice === c.id), "px-1.5")}
          >
            {c.label}
          </button>
        ))}
      </div>
      {value?.enabled && <SizeRow value={value} onChange={onChange} />}
      <p className="text-[11px] leading-snug text-foreground/50">{hint}</p>
    </div>
  );
}

/** The size to scale to: a number, in pixels (longest side) or percent. */
function SizeRow({
  value,
  onChange,
}: {
  value: ImageScaling;
  onChange: (next: ImageScaling) => void;
}) {
  const range = value.mode === "px" ? IMAGE_SCALING_PX : IMAGE_SCALING_PERCENT;
  const current = value.mode === "px" ? value.px : value.percent;
  const [draft, setDraft] = useState(String(current));
  useEffect(() => setDraft(String(current)), [current]);

  // Saved on blur or Enter, clamped to what the backend accepts; anything
  // that isn't a number puts the saved value back.
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) {
      setDraft(String(current));
      return;
    }
    const size = Math.min(range.max, Math.max(range.min, n));
    setDraft(String(size));
    if (size !== current) {
      onChange(value.mode === "px" ? { ...value, px: size } : { ...value, percent: size });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-label={value.mode === "px" ? "Longest side, in pixels" : "Size, in percent of the original"}
        className="h-8 w-24 text-sm"
      />
      <div
        role="radiogroup"
        aria-label="Unit"
        className="inline-flex rounded-xl border border-foreground/10 bg-foreground/[0.04] p-0.5"
      >
        {(["px", "percent"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value.mode === mode}
            onClick={() => mode !== value.mode && onChange({ ...value, mode })}
            className={cn(segmentClass(value.mode === mode), "px-2.5")}
            title={mode === "px" ? "Cap the longest side, in pixels" : "Shrink to a share of the original size"}
          >
            {mode === "px" ? "px" : "%"}
          </button>
        ))}
      </div>
    </div>
  );
}
