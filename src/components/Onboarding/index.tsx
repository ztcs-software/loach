import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { cn } from "@/lib/utils";
import { WelcomeStep } from "./WelcomeStep";
import { NameStep } from "./NameStep";
import { ProviderStep } from "./ProviderStep";
import { PromptStep } from "./PromptStep";
import { FeaturesStep } from "./FeaturesStep";
import { FinalStep } from "./FinalStep";

/**
 * Onboarding overlay. Mounted by `App.tsx` whenever
 * `settings.onboarding_completed === false` (and the security gate has
 * passed). Sits above the regular app surface but *below* the TitleBar
 * so window controls (min / max / close-to-tray) keep working — same
 * pattern as `LockScreen`.
 *
 * Closing rules:
 *   - X / Esc on most steps: dismiss immediately (and mark complete so
 *     onboarding doesn't re-fire).
 *   - X / Esc on the provider step: route through a small inline confirm
 *     ("Skip setup? You can configure later.") so the only required
 *     step isn't accidentally bypassed. The user can still dismiss —
 *     they just have to mean it.
 */

export function Onboarding() {
  const step = useOnboardingStore((s) => s.step);
  const confirming = useOnboardingStore((s) => s.confirmingClose);
  const setConfirming = useOnboardingStore((s) => s.setConfirmingClose);
  const complete = useOnboardingStore((s) => s.complete);

  const handleClose = () => {
    if (step === "provider") {
      setConfirming(true);
      return;
    }
    void complete();
  };

  // Esc → close (with the same confirm gating as the X button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirming) {
          setConfirming(false);
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handleClose closes over `step`/`confirming` — re-bind on change so
    // Esc routes correctly through the latest gate state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, confirming]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-[55] flex items-center justify-center",
        // Match the dialog overlay used by Settings (`bg-black/55 backdrop-blur-md`).
        "bg-black/55 backdrop-blur-md",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
      )}
      data-state="open"
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding"
    >
      <div
        className={cn(
          "glass-panel",
          "relative flex max-h-[88vh] w-[min(880px,94vw)] flex-col",
          // Match SettingsDialog's surface: gradient-tinted glass with
          // backdrop blur + saturation. A darkening underlay (below) gives
          // it the same deep tone as the Settings reference instead of the
          // washed-out look pure glass produced over our mesh.
          "rounded-3xl",
          "overflow-hidden",
          "h-[560px]",
        )}
      >
        {/* Darken the glass so the panel reads as deep as Settings. Sits
            inside the glass frame (keeping its border / inner highlight)
            but behind the step content. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-background/55"
        />
        <div className="relative z-10 flex flex-1 min-h-0 flex-col">
          {step === "welcome" && <WelcomeStep onClose={handleClose} />}
          {step === "name" && <NameStep onClose={handleClose} />}
          {step === "provider" && <ProviderStep onClose={handleClose} />}
          {step === "prompt" && <PromptStep onClose={handleClose} />}
          {step === "features" && <FeaturesStep onClose={handleClose} />}
          {step === "final" && <FinalStep onClose={handleClose} />}
        </div>

        {/* Provider-step dismiss confirm. Renders as an in-card overlay
            so it visually owns the modal's full surface; the underlying
            step state is preserved (cancel returns the user to exactly
            where they were). */}
        {confirming && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/75 backdrop-blur-sm">
            <div className="mx-6 max-w-sm rounded-2xl border border-foreground/10 bg-background/95 p-5 shadow-xl">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14.5px] font-semibold">Skip setup?</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/60">
                    You'll need to configure a provider before you can chat.
                    You can do it any time from Settings → Providers.
                  </p>
                </div>
              </div>
              {/* Hierarchy: the safe action ("Keep configuring") is the
                  primary, prominent button; the destructive option
                  ("Skip anyway") is demoted to a muted ghost so a user
                  reflexively clicking the brighter target lands on the
                  recoverable choice. */}
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirming(false);
                    void complete();
                  }}
                  className="text-foreground/55 hover:text-foreground"
                >
                  Skip anyway
                </Button>
                <Button
                  size="sm"
                  onClick={() => setConfirming(false)}
                  autoFocus
                >
                  Keep configuring
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
