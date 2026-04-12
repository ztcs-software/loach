import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { DEFAULT_PARAMS, type GenerationParams, type Session } from "@/types";

function readParams(s: Session | undefined): GenerationParams {
  if (!s?.params_json) return { ...DEFAULT_PARAMS };
  try {
    return { ...DEFAULT_PARAMS, ...JSON.parse(s.params_json) };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

export function ParameterPanel({ session }: { session: Session | undefined }) {
  const open = useUIStore((s) => s.paramsOpen);
  const toggle = useUIStore((s) => s.toggleParams);
  const setSessionParams = useChatStore((s) => s.setSessionParams);
  const setSessionSystemPrompt = useChatStore((s) => s.setSessionSystemPrompt);

  const initial = useMemo(() => readParams(session), [session]);
  const [params, setParams] = useState<GenerationParams>(initial);
  const [systemPrompt, setSystemPrompt] = useState(session?.system_prompt ?? "");

  useEffect(() => {
    setParams(initial);
    setSystemPrompt(session?.system_prompt ?? "");
  }, [session?.id, initial, session?.system_prompt]);

  const update = (patch: Partial<GenerationParams>) => {
    if (!session) return;
    const next = { ...params, ...patch };
    setParams(next);
    setSessionParams(session.id, next);
  };

  if (!open) return null;

  return (
    <aside className="flex h-full w-72 flex-col border-l border-border/60 bg-background/40">
      <div className="flex h-12 items-center justify-between border-b border-border/60 px-3">
        <span className="text-sm font-semibold">Parameters</span>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Close panel">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {!session ? (
          <p className="text-xs text-muted-foreground">Open a chat to adjust parameters.</p>
        ) : (
          <div className="space-y-5">
            <SliderRow
              label="Temperature"
              value={params.temperature ?? 0.7}
              min={0}
              max={2}
              step={0.05}
              onChange={(v) => update({ temperature: v })}
            />
            <SliderRow
              label="Top-P"
              value={params.top_p ?? 0.95}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => update({ top_p: v })}
            />
            <SliderRow
              label="Max Tokens"
              value={params.max_tokens ?? 2048}
              min={64}
              max={32768}
              step={64}
              precision={0}
              onChange={(v) => update({ max_tokens: Math.round(v) })}
            />
            <SliderRow
              label="Frequency Penalty"
              value={params.frequency_penalty ?? 0}
              min={-2}
              max={2}
              step={0.05}
              onChange={(v) => update({ frequency_penalty: v })}
            />
            <SliderRow
              label="Presence Penalty"
              value={params.presence_penalty ?? 0}
              min={-2}
              max={2}
              step={0.05}
              onChange={(v) => update({ presence_penalty: v })}
            />
            <SliderRow
              label="Context Length"
              value={params.num_ctx ?? 4096}
              min={512}
              max={131072}
              step={256}
              precision={0}
              onChange={(v) => update({ num_ctx: Math.round(v) })}
              hint={
                session.provider === "openai"
                  ? "Ignored for OpenAI providers."
                  : "Overrides the model default (Ollama only)."
              }
            />
            <Separator />
            <div>
              <Label htmlFor="session-system-prompt">System prompt (this chat)</Label>
              <Textarea
                id="session-system-prompt"
                rows={5}
                placeholder="Override the global system prompt for this chat…"
                className="mt-1.5"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onBlur={() =>
                  session && setSessionSystemPrompt(session.id, systemPrompt)
                }
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  precision = 2,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  precision?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label>{label}</Label>
        <span className="font-mono text-xs text-muted-foreground">
          {value.toFixed(precision)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
      />
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
