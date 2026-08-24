import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ONBOARDING_STEPS,
  type OnboardingStep,
} from "@/stores/onboardingStore";

/**
 * Common chrome for every onboarding step. Holds the close X (top-right),
 * the optional title block, the slot for step body, and the bottom row
 * with Back / Skip / Next. Each step renders inside this so the wizard
 * stays visually identical from screen to screen — a swap of the body
 * only.
 *
 * Rationale for the layout:
 *   - X always visible and at a fixed position (top-right corner of the
 *     card), matching the SettingsDialog close affordance.
 *   - Progress dots at the *bottom* below the buttons so they read as a
 *     compass without distracting from the headline.
 *   - Skip is a flat link-styled button, not a primary action — it sits
 *     to the *left* of Next so users don't accidentally Tab onto it.
 */

export interface StepShellProps {
  step: OnboardingStep;
  title: string;
  subtitle?: string | ReactNode;
  /** Hide the title block when the step body owns its own hero (welcome,
   *  final). The X / progress chrome still mounts. */
  hideHeader?: boolean;
  /** Center the body vertically inside the shell — used by Welcome and
   *  Final, which have no action bar pulling weight to the bottom. */
  centerY?: boolean;
  children: ReactNode;
  /** Bottom buttons. Pass null to hide the row entirely (welcome /
   *  final use a single CTA inside their body). */
  primaryLabel?: string | null;
  primaryIcon?: "next" | "check";
  primaryDisabled?: boolean;
  onPrimary?: () => void;
  /** Show a Skip button to the left of Next. */
  skippable?: boolean;
  onSkip?: () => void;
  /** Allow the user to step backward. Hidden on `welcome`. */
  canGoBack?: boolean;
  onBack?: () => void;
  onClose: () => void;
}

export function StepShell({
  step,
  title,
  subtitle,
  hideHeader,
  centerY,
  children,
  primaryLabel = "Continue",
  primaryIcon = "next",
  primaryDisabled,
  onPrimary,
  skippable,
  onSkip,
  canGoBack,
  onBack,
  onClose,
}: StepShellProps) {
  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Close X — always visible, always works. The provider step
          intercepts the click via `onClose` to gate on the confirm
          prompt; every other step closes immediately. */}
      <button
        type="button"
        aria-label="Close onboarding"
        onClick={onClose}
        className={cn(
          "absolute right-5 top-5 z-10 inline-flex h-8 w-8 items-center justify-center",
          "rounded-full text-foreground/55 transition-colors",
          "hover:bg-foreground/[0.08] hover:text-foreground",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        )}
      >
        <X className="h-4 w-4" />
      </button>

      {/* Body — scrolls if its content overflows. `centerY` pins the
          inner block to the vertical centre for hero-style screens
          (welcome / final) which have no action bar tugging the eye
          downward. */}
      <div
        className={cn(
          "flex flex-1 min-h-0 flex-col items-center overflow-y-auto px-10",
          centerY ? "justify-center py-10" : "pb-6 pt-14",
        )}
      >
        <div className="flex w-full max-w-2xl flex-col">
          {!hideHeader && (
            <header className="mb-6 text-center">
              <h2 className="text-[22px] font-semibold tracking-tight text-foreground">
                {title}
              </h2>
              {subtitle && (
                <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-foreground/55">
                  {subtitle}
                </p>
              )}
            </header>
          )}
          {children}
        </div>
      </div>

      {/* Bottom action bar. Rendered when the step has a primary button OR
          asks for Back — gating the whole bar on `primaryLabel` meant the
          final step's `canGoBack` was dead code and that screen had no way
          back at all. Welcome / Final still hide the bar entirely when they
          want neither, because their bodies own the single hero CTA. */}
      {(primaryLabel !== null || canGoBack) && (
        <div className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] px-6 py-4">
          <div className="flex items-center gap-1">
            {canGoBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="gap-1.5 text-foreground/70"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {skippable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onSkip}
                className="text-foreground/55 hover:text-foreground"
              >
                Skip
              </Button>
            )}
            {/* Guarded on the label too, not just the bar. The final step
                asks for the bar (`canGoBack`) while passing
                `primaryLabel={null}`, which rendered an enabled button with
                no text, no accessible name, and `onClick` undefined — a
                live-looking arrow that did nothing. */}
            {primaryLabel !== null && (
              <Button
                onClick={onPrimary}
                disabled={primaryDisabled}
                className="gap-1.5 px-5"
              >
                {primaryLabel}
                {primaryIcon === "check" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Progress dots, fixed at the very bottom. Lives outside the
          action bar so welcome/final still get a progress hint. */}
      <ProgressDots active={step} />
    </div>
  );
}

function ProgressDots({ active }: { active: OnboardingStep }) {
  const activeIdx = ONBOARDING_STEPS.indexOf(active);
  return (
    <div className="flex items-center justify-center gap-1.5 pb-4 pt-1">
      {ONBOARDING_STEPS.map((step, i) => {
        const done = i < activeIdx;
        const current = i === activeIdx;
        return (
          <span
            key={step}
            className={cn(
              "h-1.5 rounded-full transition-all duration-300",
              current
                ? "w-5 bg-primary"
                : done
                  ? "w-1.5 bg-foreground/40"
                  : "w-1.5 bg-foreground/15",
            )}
            aria-hidden
          />
        );
      })}
    </div>
  );
}
