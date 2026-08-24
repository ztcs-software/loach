//! Settings -> Appearance: the theme / colour-mode tiles and the miniature
//! app previews they render. Pure presentation driven by the settings store.

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { memo } from "react";

type Tone = "light" | "dark";
type Variant = "solid" | "gradient";

export function resolveMode(theme: "light" | "dark" | "system"): Tone {
  if (theme === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  }
  return theme;
}

export function AppearanceTile({
  title,
  selected,
  onClick,
  children,
}: {
  title: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl text-left",
        "border-2 transition-all duration-200",
        selected
          ? "border-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]"
          : "border-foreground/10 hover:border-foreground/25 hover:-translate-y-0.5",
      )}
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden">
        {children}
      </div>
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2 transition-colors",
          selected ? "bg-primary/5" : "bg-transparent",
        )}
      >
        <span className="text-[13px] font-medium">{title}</span>
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-foreground/25 group-hover:border-foreground/45",
          )}
          aria-hidden
        >
          {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      </div>
    </button>
  );
}

/** Backdrop for a mini preview — mirrors `app-mesh` / `app-solid` in globals.css. */
function PreviewBackdrop({ variant, mode }: { variant: Variant; mode: Tone }) {
  if (variant === "solid") {
    return (
      <div
        className="absolute inset-0"
        style={{ background: mode === "dark" ? "#0b0d14" : "#f4efe8" }}
      />
    );
  }
  // Aurora — radial blurs layered on a diagonal base, matching the real app.
  const bg =
    mode === "dark"
      ? [
          "radial-gradient(at 6% 16%, hsla(225, 75%, 22%, 0.95) 0px, transparent 55%)",
          "radial-gradient(at 18% 82%, hsla(255, 60%, 22%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 58% 28%, hsla(305, 60%, 28%, 0.55) 0px, transparent 55%)",
          "radial-gradient(at 82% 58%, hsla(14, 80%, 42%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 96% 88%, hsla(8, 85%, 38%, 0.85) 0px, transparent 55%)",
          "linear-gradient(125deg, #080a1a 0%, #140e22 35%, #361618 70%, #4a1a10 100%)",
        ].join(", ")
      : [
          "radial-gradient(at 6% 16%, hsla(28, 95%, 88%, 0.95) 0px, transparent 55%)",
          "radial-gradient(at 16% 82%, hsla(202, 85%, 90%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 58% 28%, hsla(268, 70%, 93%, 0.65) 0px, transparent 55%)",
          "radial-gradient(at 82% 58%, hsla(18, 92%, 84%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 96% 88%, hsla(342, 85%, 90%, 0.85) 0px, transparent 55%)",
          "linear-gradient(125deg, #f4f2e7 0%, #eee0f2 35%, #f8d7cf 70%, #f8c9a8 100%)",
        ].join(", ");
  return <div className="absolute inset-0" style={{ backgroundImage: bg }} />;
}

/** Miniature of the Loach layout (sidebar + main + composer). */
function MiniUIFrame({ mode, variant }: { mode: Tone; variant: Variant }) {
  const isDark = mode === "dark";
  // Aurora uses semi-transparent glass so the mesh shows through; solid uses
  // a slightly more opaque chrome.
  const glass = isDark
    ? variant === "gradient"
      ? "rgba(255,255,255,0.07)"
      : "rgba(255,255,255,0.05)"
    : variant === "gradient"
      ? "rgba(255,255,255,0.55)"
      : "rgba(0,0,0,0.035)";
  const stroke = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";
  const fg = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.7)";
  const muted = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)";
  const accent = "hsl(14, 85%, 55%)";

  return (
    <div className="absolute inset-0 flex gap-1 p-1.5">
      {/* Sidebar */}
      <div
        className="flex w-[26%] flex-col gap-1 rounded-[5px] p-1.5"
        style={{ background: glass, boxShadow: `inset 0 0 0 1px ${stroke}` }}
      >
        <div className="h-1 rounded-sm" style={{ background: accent, width: "60%" }} />
        <div className="mt-1 h-0.5 rounded-sm" style={{ background: muted, width: "80%" }} />
        <div className="h-0.5 rounded-sm" style={{ background: muted, width: "55%" }} />
        <div className="h-0.5 rounded-sm" style={{ background: muted, width: "70%" }} />
      </div>

      {/* Main column */}
      <div className="flex flex-1 flex-col gap-1">
        {/* Messages area */}
        <div className="flex flex-1 flex-col justify-end gap-1 pr-1">
          <div
            className="ml-auto h-2 rounded-[3px]"
            style={{ background: accent, opacity: 0.85, width: "55%" }}
          />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "90%" }} />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "75%" }} />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "82%" }} />
        </div>
        {/* Composer */}
        <div
          className="h-3 rounded-[4px]"
          style={{ background: glass, boxShadow: `inset 0 0 0 1px ${stroke}` }}
        />
      </div>
    </div>
  );
}

// `memo` because the parent SettingsDialog re-renders on every keystroke
// in any of its textareas (it subscribes to the whole settings store
// because nearly every field is rendered somewhere in the dialog). The
// preview tiles only depend on `variant` + `mode` — primitive strings —
// so memoising stops them from re-painting their gradients + SVG clip
// paths every time an unrelated field updates.
export const ThemePreview = memo(function ThemePreview({
  variant,
  mode,
}: {
  variant: Variant;
  mode: Tone;
}) {
  return (
    <>
      <PreviewBackdrop variant={variant} mode={mode} />
      <MiniUIFrame variant={variant} mode={mode} />
    </>
  );
});

/**
 * Color-mode preview. For "system" we clip a light mockup and a dark mockup
 * along a diagonal so the tile reads as "whichever matches your OS".
 */
export const ColorModePreview = memo(function ColorModePreview({
  mode,
  variant,
}: {
  mode: "light" | "dark" | "system";
  variant: Variant;
}) {
  if (mode !== "system") {
    return <ThemePreview variant={variant} mode={mode} />;
  }
  return (
    <>
      {/* Light half (top-left) */}
      <div
        className="absolute inset-0"
        style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}
      >
        <ThemePreview variant={variant} mode="light" />
      </div>
      {/* Dark half (bottom-right) */}
      <div
        className="absolute inset-0"
        style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
      >
        <ThemePreview variant={variant} mode="dark" />
      </div>
      {/* Split hairline */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom left, transparent calc(50% - 0.5px), rgba(255,255,255,0.35) 50%, transparent calc(50% + 0.5px))",
        }}
        aria-hidden
      />
    </>
  );
});

/**
 * Embedded Archive browser — same rows the old full-page ArchiveView had,
 * just squeezed into the Settings dialog's right column. Opening a chat
 * closes the dialog so the user lands straight in the chat.
 */
