import { PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { useUIStore } from "@/stores/uiStore";
import { StepShell } from "./StepShell";

/**
 * Closer screen. Marks `onboarding_completed` true, kicks off a fresh
 * chat session, and arms the ChatHeader to auto-open its model picker
 * so the user's first action lands on the model selection dropdown.
 */

export function FinalStep({ onClose }: { onClose: () => void }) {
  const complete = useOnboardingStore((s) => s.complete);
  const goBack = useOnboardingStore((s) => s.goBack);
  const setPendingOpenModelPicker = useUIStore(
    (s) => s.setPendingOpenModelPicker,
  );

  const handleStart = async () => {
    // Arm the picker before complete() runs — complete() creates the
    // new chat session, and ChatHeader reads pendingOpenModelPicker
    // when that session mounts.
    setPendingOpenModelPicker(true);
    await complete();
    // No need to call onClose — once `onboarding_completed` flips, the
    // App-level gate unmounts the wizard automatically on the next
    // render.
  };

  return (
    <StepShell
      step="final"
      title=""
      hideHeader
      centerY
      primaryLabel={null}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <div className="flex flex-col items-center text-center">
        <div className="relative mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-foreground/[0.04] shadow-[0_0_40px_rgba(255,120,60,0.18)]">
          <Logo size={48} />
          <span className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
            <PartyPopper className="h-3.5 w-3.5" />
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          You're all set
        </h1>
        <p className="mt-2.5 max-w-sm text-[13.5px] leading-relaxed text-foreground/60">
          Loach is ready to chat. Anything set up here may be later
          changed in Settings.
        </p>

        <Button
          onClick={() => void handleStart()}
          className="mt-8 gap-2 px-6 py-5 text-[14px]"
        >
          Start chatting
        </Button>
      </div>
    </StepShell>
  );
}
