import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Persona } from "@/lib/personas";
import type { Tone } from "@/lib/tones";

// ---------------------------------------------------------------------------
// Shared geometry for every chip in the row above the composer.
//
// Two variants, differing only in surface tint — everything else (height,
// radius, padding, type scale, remove target) is identical so the row reads
// as one family:
//
//   - "config"     → persona / tone. Accent-tinted. Sticks across sends.
//   - "attachment" → files. Neutral. Leaves the composer on send.
//
// That single difference is the only real one: config outlives the message,
// payload doesn't. The row draws a `ChipDivider` between the two groups when
// both are present.
//
// The accent comes from `--primary`, not a hardcoded orange, so the chips
// follow the Solid background's azure the same way the rest of the UI does.
// Labels stay on `--foreground`: `--primary` is a saturated 60%-lightness
// orange that reads fine as an icon but fails contrast as small text on the
// light glass.
// ---------------------------------------------------------------------------

export type ComposerChipVariant = "config" | "attachment";

export function composerChipClass(variant: ComposerChipVariant) {
  return cn(
    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium text-foreground",
    variant === "config"
      ? "border-primary/40 bg-primary/10"
      // Not `border-border/60`: `--border` already carries an alpha slot
      // (`0 0% 100% / 0.10`), so a second opacity modifier makes the `hsl()`
      // invalid and Tailwind falls back to opaque white — a hard outline
      // twice as loud as the config chip's tint sitting right beside it.
      : "border-foreground/15 bg-muted/40",
  );
}

/** Icon tint for the leading glyph — accent for config, muted for payload. */
export function composerChipIconClass(variant: ComposerChipVariant) {
  return cn(
    "h-3.5 w-3.5 shrink-0",
    variant === "config" ? "text-primary" : "text-foreground/55",
  );
}

export function ChipRemove({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Attachment chips nest this inside AttachmentActions' click-to-preview
        // wrapper — without this the ✕ would also open the preview.
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
    >
      <X className="h-3 w-3" />
    </button>
  );
}

/** Hairline between the config chips and the attachment chips. */
export function ChipDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-foreground/15" />;
}

// ---------------------------------------------------------------------------
// The two config chips. Shared by the main composer and Private Chat's — the
// stores differ (session-keyed vs. overlay-local) but the chips don't, so the
// callers resolve the active persona / tone and pass it down.
// ---------------------------------------------------------------------------

export function PersonaChip({
  persona,
  onRemove,
}: {
  persona: Persona;
  onRemove: () => void;
}) {
  const Icon = persona.icon;
  return (
    <div
      className={composerChipClass("config")}
      title={`Persona: ${persona.label} — ${persona.description}`}
    >
      <Icon className={composerChipIconClass("config")} />
      <span>{persona.label}</span>
      <ChipRemove label={`Remove ${persona.label} persona`} onClick={onRemove} />
    </div>
  );
}

export function ToneChip({
  tone,
  fromGlobal,
  onRemove,
}: {
  tone: Tone;
  // True when the tone is inherited from Settings → General rather than set
  // on this chat. Only the tooltip changes — the chip looks the same either
  // way, because the effect on the next send is identical.
  fromGlobal: boolean;
  onRemove: () => void;
}) {
  const Icon = tone.icon;
  return (
    <div
      className={composerChipClass("config")}
      title={`Tone: ${tone.label} (${
        fromGlobal ? "your global default" : "set for this chat"
      }) — ${tone.description}`}
    >
      <Icon className={composerChipIconClass("config")} />
      <span>{tone.label}</span>
      <ChipRemove label={`Remove ${tone.label} tone`} onClick={onRemove} />
    </div>
  );
}
