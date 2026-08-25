import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { cn } from "@/lib/utils";
import { StepShell } from "./StepShell";

const EXAMPLE_PROMPT = `You are a concise, technically rigorous assistant. The user's name is {{USER_NAME}}. When unsure, say so rather than guessing. Default to short answers; expand only when asked.`;

/**
 * Custom instructions step. Skippable. Saves to `global_system_prompt` —
 * the same field surfaced as "Custom instructions" in Settings.
 *
 * The expandable example exists for two reasons: (a) it shows the
 * `{{USER_NAME}}` template variable in context, which is otherwise
 * invisible to a new user, and (b) "Use example" gives a one-click
 * starting point so the user can iterate from a working baseline
 * instead of staring at an empty box.
 */

export function PromptStep({ onClose }: { onClose: () => void }) {
  const initial = useSettingsStore((s) => s.global_system_prompt);
  const update = useSettingsStore((s) => s.update);
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  const [value, setValue] = useState(initial);
  const [expanded, setExpanded] = useState(false);

  const commit = async () => {
    await update("global_system_prompt", value);
    goNext();
  };

  return (
    <StepShell
      step="prompt"
      title="Add custom instructions"
      subtitle="Applied to every new chat. Set the tone, persona, or output style. Loach passes this to the model as the system prompt."
      onPrimary={() => void commit()}
      skippable
      onSkip={goNext}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Textarea
          id="onboarding-custom-instructions"
          aria-label="Custom instructions"
          rows={8}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="You are a helpful assistant…"
          className="resize-none text-[13px] leading-relaxed"
        />

        <div className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.02]">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls="onboarding-prompt-example"
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
          >
            <span className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-[12.5px] font-medium">Display an example</span>
            </span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-foreground/45 transition-transform",
                expanded ? "rotate-180" : "rotate-0",
              )}
            />
          </button>
          {expanded && (
            <div
              id="onboarding-prompt-example"
              className="border-t border-foreground/[0.06] p-3.5"
            >
              <p className="rounded-lg bg-foreground/[0.04] px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground/75 whitespace-pre-wrap">
                {EXAMPLE_PROMPT}
              </p>
              <button
                type="button"
                onClick={() => setValue(EXAMPLE_PROMPT)}
                className="mt-2 text-[11.5px] text-primary hover:underline underline-offset-2"
              >
                Use this example
              </button>
              <p className="mt-2 text-[11px] text-foreground/50">
                You can use template variables like{" "}
                <span className="font-mono">{"{{USER_NAME}}"}</span>,{" "}
                <span className="font-mono">{"{{CURRENT_DATE}}"}</span>, or{" "}
                <span className="font-mono">{"{{CURRENT_TIME}}"}</span>.
              </p>
            </div>
          )}
        </div>
      </div>
    </StepShell>
  );
}
