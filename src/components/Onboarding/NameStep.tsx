import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { StepShell } from "./StepShell";

/**
 * Name capture. Skippable — most users will fill it but the field is
 * never required. Submitted via Enter or the bottom Continue button.
 *
 * The value is committed to settings on Continue (not on each keystroke)
 * so a mid-wizard X press doesn't leave the user with a half-typed name
 * persisted as their identity.
 */

export function NameStep({ onClose }: { onClose: () => void }) {
  const initial = useSettingsStore((s) => s.user_name);
  const update = useSettingsStore((s) => s.update);
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = async () => {
    const trimmed = name.trim();
    if (trimmed) await update("user_name", trimmed);
    goNext();
  };

  return (
    <StepShell
      step="name"
      title="What should Loach call you?"
      subtitle={
        <>
          Optional. Available later as{" "}
          <span className="font-mono text-foreground/70">{"{{USER_NAME}}"}</span>{" "}
          variable in custom instructions.
        </>
      }
      onPrimary={() => void commit()}
      skippable
      onSkip={goNext}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void commit();
        }}
        className="flex justify-center"
      >
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="h-11 w-72 text-[14px]"
          maxLength={64}
        />
      </form>
    </StepShell>
  );
}
