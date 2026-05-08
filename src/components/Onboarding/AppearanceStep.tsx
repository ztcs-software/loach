import { Check } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import type { BackgroundStyle, ThemeChoice } from "@/types";
import { cn } from "@/lib/utils";
import { StepShell } from "./StepShell";

/**
 * Appearance picker. Four tiles covering the cross product of:
 *   - background_style: "gradient" (Aurora) | "solid"
 *   - theme:            "dark" | "light"
 *
 * Aurora Dark is the existing app default and the recommended pick;
 * we mark it explicitly. Selection updates settings live so the user
 * can preview the change against the actual app chrome behind the
 * onboarding overlay.
 *
 * Note: previews are inlined here (small mini-mockup of the Loach
 * layout) instead of lifted out of SettingsDialog. If we add a third
 * place that needs them we should refactor — until then a duplicate
 * is cheaper than a shared util.
 */

type Tone = "light" | "dark";
type Variant = BackgroundStyle;

const TILES: {
  variant: Variant;
  mode: Tone;
  label: string;
  recommended?: boolean;
}[] = [
  { variant: "gradient", mode: "dark", label: "Aurora Dark", recommended: true },
  { variant: "solid", mode: "dark", label: "Solid Dark" },
  { variant: "gradient", mode: "light", label: "Aurora Light" },
  { variant: "solid", mode: "light", label: "Solid Light" },
];

export function AppearanceStep({ onClose }: { onClose: () => void }) {
  const theme = useSettingsStore((s) => s.theme);
  const bg = useSettingsStore((s) => s.background_style);
  const update = useSettingsStore((s) => s.update);
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  // For the purpose of matching against tiles, treat "system" the same as
  // dark — the preview tiles only render an explicit tone, and clicking
  // a tile flips the theme to that explicit value anyway.
  const currentTone: Tone = theme === "light" ? "light" : "dark";

  const select = (variant: Variant, mode: Tone) => {
    void update("background_style", variant);
    if ((mode === "dark" ? "dark" : "light") !== theme) {
      void update("theme", mode as ThemeChoice);
    }
  };

  return (
    <StepShell
      step="appearance"
      title="Pick a look"
      subtitle="You can switch any time from Settings → Appearance."
      onPrimary={goNext}
      skippable
      onSkip={goNext}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <div className="grid grid-cols-2 gap-3">
        {TILES.map((t) => {
          const selected = t.variant === bg && t.mode === currentTone;
          return (
            <Tile
              key={`${t.variant}-${t.mode}`}
              label={t.label}
              variant={t.variant}
              mode={t.mode}
              selected={selected}
              recommended={t.recommended}
              onClick={() => select(t.variant, t.mode)}
            />
          );
        })}
      </div>
    </StepShell>
  );
}

function Tile({
  label,
  variant,
  mode,
  selected,
  recommended,
  onClick,
}: {
  label: string;
  variant: Variant;
  mode: Tone;
  selected: boolean;
  recommended?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl text-left",
        "border-2 transition-all duration-200",
        selected
          ? "border-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]"
          : "border-foreground/10 hover:border-foreground/25 hover:-translate-y-0.5",
      )}
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden">
        <Backdrop variant={variant} mode={mode} />
        <MiniFrame variant={variant} mode={mode} />
        {recommended && (
          <span className="absolute right-2 top-2 rounded-full bg-primary/90 px-2 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-primary-foreground">
            Recommended
          </span>
        )}
      </div>
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2 transition-colors",
          selected ? "bg-primary/5" : "bg-transparent",
        )}
      >
        <span className="text-[12.5px] font-medium">{label}</span>
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

function Backdrop({ variant, mode }: { variant: Variant; mode: Tone }) {
  if (variant === "solid") {
    return (
      <div
        className="absolute inset-0"
        style={{ background: mode === "dark" ? "#0b0d14" : "#f4efe8" }}
      />
    );
  }
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

function MiniFrame({ variant, mode }: { variant: Variant; mode: Tone }) {
  const isDark = mode === "dark";
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
      <div
        className="flex w-[26%] flex-col gap-1 rounded-[5px] p-1.5"
        style={{ background: glass, boxShadow: `inset 0 0 0 1px ${stroke}` }}
      >
        <div className="h-1 rounded-sm" style={{ background: accent, width: "60%" }} />
        <div className="mt-1 h-0.5 rounded-sm" style={{ background: muted, width: "80%" }} />
        <div className="h-0.5 rounded-sm" style={{ background: muted, width: "55%" }} />
        <div className="h-0.5 rounded-sm" style={{ background: muted, width: "70%" }} />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex flex-1 flex-col justify-end gap-1 pr-1">
          <div
            className="ml-auto h-2 rounded-[3px]"
            style={{ background: accent, opacity: 0.85, width: "55%" }}
          />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "90%" }} />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "75%" }} />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "82%" }} />
        </div>
        <div
          className="h-3 rounded-[4px]"
          style={{ background: glass, boxShadow: `inset 0 0 0 1px ${stroke}` }}
        />
      </div>
    </div>
  );
}
