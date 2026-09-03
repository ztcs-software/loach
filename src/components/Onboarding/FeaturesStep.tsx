import { useState } from "react";
import { Brain, Clock, MemoryStick } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { StepShell } from "./StepShell";

/**
 * Feature toggles. Three defaults that are easier to set once at onboarding
 * than to discover later in Settings:
 *
 *   - Temporal awareness (date/time injection): ON by default. Cheap
 *     and fixes the "what's today's date?" surprise.
 *   - Thinking: ON by default. Reasoning models default to thinking
 *     unless the model author says otherwise.
 *   - Low VRAM: OFF by default. Hurts speed if you don't need it; the
 *     in-chat toggle is right there if a model OOMs.
 *
 * All three are committed to settings on Continue *and* on Skip —
 * establishing defaults is the wizard's job, and none of these three reaches
 * the network or changes what the model is allowed to do. Web fetch used to
 * live here and needed a carve-out for exactly that reason; it now sits on
 * the Tools step, which writes nothing the user didn't touch.
 */

interface DraftFeatures {
  temporal_awareness: boolean;
  thinking_default: boolean;
  low_vram_global: boolean;
}

const RECOMMENDED: DraftFeatures = {
  temporal_awareness: true,
  thinking_default: true,
  low_vram_global: false,
};

export function FeaturesStep({ onClose }: { onClose: () => void }) {
  const update = useSettingsStore((s) => s.update);
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  // Seeded from RECOMMENDED rather than current settings — the wizard's
  // job is to *establish* defaults, not echo whatever's already there
  // from a half-finished prior run.
  const [draft, setDraft] = useState<DraftFeatures>(RECOMMENDED);

  const set = <K extends keyof DraftFeatures>(k: K, v: DraftFeatures[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const commit = async () => {
    await Promise.all([
      update("temporal_awareness", draft.temporal_awareness),
      update("thinking_default", draft.thinking_default),
      update("low_vram_global", draft.low_vram_global),
    ]);
    goNext();
  };

  return (
    <StepShell
      step="features"
      title="Pick your defaults"
      subtitle="Tune later in Settings — these are just the defaults Loach starts with."
      onPrimary={() => void commit()}
      skippable
      onSkip={() => void commit()}
      canGoBack
      onBack={goBack}
      onClose={onClose}
    >
      <div className="space-y-2">
        <FeatureRow
          icon={<Clock className="h-4 w-4" />}
          title="Temporal awareness"
          description="Inject the current date, time, weekday, and timezone into every chat so the model can answer 'what's today's date?' correctly."
          checked={draft.temporal_awareness}
          onChange={(v) => set("temporal_awareness", v)}
        />
        <FeatureRow
          icon={<Brain className="h-4 w-4" />}
          title="Thinking"
          description="Default for the per-chat Thinking toggle. Only takes effect on thinking-capable Ollama models. Different providers ignore it."
          checked={draft.thinking_default}
          onChange={(v) => set("thinking_default", v)}
        />
        <FeatureRow
          icon={<MemoryStick className="h-4 w-4" />}
          title="Low VRAM mode"
          description="Force Ollama into low-VRAM mode for every chat for smaller batches and leaner KV cache. This setting overrides the per-chat Low VRAM toggle so you don't have to flip it on each new session. Ignored by OpenAI API providers."
          checked={draft.low_vram_global}
          onChange={(v) => set("low_vram_global", v)}
        />
      </div>
    </StepShell>
  );
}

function FeatureRow({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-foreground/[0.06] bg-foreground/[0.015] p-3.5 transition-colors hover:bg-foreground/[0.025]">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-foreground/75">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/55">
          {description}
        </p>
      </div>
      {/* Named after the row's own title. Settings → Features labels the
          same toggles; these were the only unnamed ones, so a screen
          reader heard three consecutive "switch, on" with nothing to tell
          them apart. */}
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={checked ? `Disable ${title}` : `Enable ${title}`}
        className="mt-1 shrink-0"
      />
    </div>
  );
}
