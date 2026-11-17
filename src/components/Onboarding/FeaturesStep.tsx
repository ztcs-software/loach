import { useState } from "react";
import { BookMarked, Brain, Clock, Gauge } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ContextLengthSwitch } from "@/components/settings/switches";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { DEFAULT_SETTINGS } from "@/types";
import { StepShell } from "./StepShell";

/**
 * Feature defaults. Four that are easier to set once at onboarding than to
 * discover later in Settings:
 *
 *   - Global memories: OFF by default. When on, every reply costs a
 *     second, hidden extraction call, so it's opt-in.
 *   - Temporal awareness (date/time injection): ON by default. Cheap
 *     and fixes the "what's today's date?" surprise.
 *   - Thinking: ON by default. Reasoning models default to thinking
 *     unless the model author says otherwise.
 *   - Default context length: the app default. Too small and chats
 *     forget early turns; too large and the model spills out of VRAM.
 *
 * All four are committed to settings on Continue *and* on Skip —
 * establishing defaults is the wizard's job, and none of these reaches the
 * network or changes what the model is allowed to do (global memory's extra
 * call goes to the provider the chat already uses, and Skip writes it OFF).
 * Web fetch used to live here and needed a carve-out for exactly that
 * reason; it now sits on the Tools step, which writes nothing the user
 * didn't touch.
 */

interface DraftFeatures {
  global_memory_enabled: boolean;
  temporal_awareness: boolean;
  thinking_default: boolean;
  default_num_ctx: number;
}

const RECOMMENDED: DraftFeatures = {
  global_memory_enabled: false,
  temporal_awareness: true,
  thinking_default: true,
  default_num_ctx: DEFAULT_SETTINGS.default_num_ctx,
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
      update("global_memory_enabled", draft.global_memory_enabled),
      update("temporal_awareness", draft.temporal_awareness),
      update("thinking_default", draft.thinking_default),
      update("default_num_ctx", draft.default_num_ctx),
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
          icon={<BookMarked className="h-4 w-4" />}
          title="Global memories"
          description="Remember facts about you across all chats. After each reply, an extra background request picks out what's worth keeping. The facts go with every chat, cloud providers included. Never used in Private Chat."
          checked={draft.global_memory_enabled}
          onChange={(v) => set("global_memory_enabled", v)}
        />
        <FeatureRow
          icon={<Clock className="h-4 w-4" />}
          title="Temporal awareness"
          description="Inject the current date, weekday, and timezone into every chat so the model can answer 'what's today's date?' correctly."
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
        <div className="flex items-start gap-3 rounded-xl border border-foreground/[0.06] bg-foreground/[0.015] p-3.5 transition-colors hover:bg-foreground/[0.025]">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-foreground/75">
            <Gauge className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">Default context length</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/55">
              How much of the conversation the model can see at once. Bigger remembers more but
              uses more VRAM, and replies slow down once it no longer fits. Ollama only.
            </p>
            <ContextLengthSwitch
              value={draft.default_num_ctx}
              onChange={(v) => set("default_num_ctx", v)}
            />
          </div>
        </div>
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
        aria-label={title}
        className="mt-1 shrink-0"
      />
    </div>
  );
}
