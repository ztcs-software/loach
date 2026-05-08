import { useEffect, useMemo, useState } from "react";
import { Brain, ChevronRight, ChevronDown, Dice5, Info, Layers, MemoryStick, RotateCcw, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUIStore } from "@/stores/uiStore";
import { DEFAULT_PARAMS, type GenerationParams, type Session } from "@/types";

function parseOverrides(json: string | null): Partial<GenerationParams> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Partial<GenerationParams>;
  } catch {
    return {};
  }
}

export function ParameterPanel({ session }: { session: Session | undefined }) {
  const open = useUIStore((s) => s.paramsOpen);
  const toggle = useUIStore((s) => s.toggleParams);
  const setSessionParams = useChatStore((s) => s.setSessionParams);
  const setSessionSystemPrompt = useChatStore((s) => s.setSessionSystemPrompt);
  const loadModelDefaults = useModelsStore((s) => s.loadModelDefaults);

  // Subscribe to the per-model patch so this component re-renders the moment
  // the lazy fetch lands. The selector returns the raw object reference, so
  // identity stability falls out of the cache structure (we always return
  // the same `{}` for "not Ollama", same patch for cached models).
  const modelDefaults = useModelsStore((s) =>
    session?.provider === "ollama" && session.model
      ? s.modelDefaults[session.model]
      : undefined,
  );
  const modelCapabilities = useModelsStore((s) =>
    session?.provider === "ollama" && session.model
      ? s.modelCapabilities[session.model]
      : undefined,
  );
  const modelThinkPref = useModelsStore((s) =>
    session?.provider === "ollama" && session.model
      ? s.modelThinkPrefs[session.model]
      : undefined,
  );
  const supportsThinking =
    session?.provider === "ollama" && (modelCapabilities?.includes("thinking") ?? false);
  // Global Low-VRAM pin (Settings → General). When on, every Ollama request
  // is sent with `low_vram: true` regardless of what's in this panel — so
  // we visually pin the per-chat toggle on and disable it, with a hint
  // pointing the user back to the global setting.
  const lowVramGlobal = useSettingsStore((s) => s.low_vram_global);

  const overrides = useMemo(
    () => parseOverrides(session?.params_json ?? null),
    [session?.params_json],
  );
  const hasOverrides = Object.keys(overrides).length > 0;

  // The merge order mirrors `chatStore.readSessionParams` exactly so the
  // sliders (and the Thinking toggle) show the same values the request
  // will actually use.
  const initial = useMemo<GenerationParams>(
    () => ({
      ...DEFAULT_PARAMS,
      ...(modelDefaults ?? {}),
      ...(modelThinkPref === undefined ? {} : { think: modelThinkPref }),
      ...overrides,
    }),
    [overrides, modelDefaults, modelThinkPref],
  );

  const [params, setParams] = useState<GenerationParams>(initial);
  const [systemPrompt, setSystemPrompt] = useState(session?.system_prompt ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setParams(initial);
    setSystemPrompt(session?.system_prompt ?? "");
  }, [session?.id, initial, session?.system_prompt]);

  // Defensive — newSession / setSessionModel already prefetch, but the panel
  // can also be opened on a session created before this code shipped.
  useEffect(() => {
    if (session?.provider === "ollama" && session.model && !modelDefaults) {
      void loadModelDefaults(session.model);
    }
  }, [session?.provider, session?.model, modelDefaults, loadModelDefaults]);

  const update = (patch: Partial<GenerationParams>) => {
    if (!session) return;
    const next = { ...params, ...patch };
    setParams(next);
    // Touching any slider snapshots the current effective values into the
    // session's overrides — including any model-default values the user
    // hasn't touched, so future model swaps don't silently shift those.
    setSessionParams(session.id, next);
  };

  // Reset clears the override entirely so the session falls back to (model
  // defaults + app defaults). For Ollama models that's the Modelfile values;
  // for OpenAI it's just app defaults.
  const resetParams = () => {
    if (!session) return;
    setParams({ ...DEFAULT_PARAMS, ...(modelDefaults ?? {}) });
    setSessionParams(session.id, null);
  };

  if (!open) return null;

  const isOpenAI = session?.provider === "openai";
  const hasModelDefaults =
    !!modelDefaults && Object.keys(modelDefaults).length > 0;
  const sourceLabel = hasOverrides
    ? "Custom — adjusted for this chat."
    : isOpenAI
      ? "Using app defaults — OpenAI doesn't expose per-model defaults."
      : hasModelDefaults
        ? `Using ${session!.model}'s Modelfile defaults.`
        : modelDefaults === undefined
          ? "Loading model defaults…"
          : "Using app defaults — this model lists no overrides.";

  // Context-length stops — powers of two are the grid models are trained on
  // and the granularity VRAM allocation cares about. Users shouldn't be able
  // to land on meaningless values like 11_847.
  const CTX_STOPS = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  const formatK = (n: number) => {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
    if (n >= 1024) return `${Math.round(n / 1024)}K`;
    return String(n);
  };

  return (
    <aside className="glass-subtle relative flex h-full w-72 flex-col overflow-hidden">
      <div className="relative flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-tight">Parameters</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label="Close panel"
          className="h-7 w-7 rounded-full text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="scrollbar-hidden relative flex-1 overflow-y-auto px-4 pb-6 pt-1">
        {!session ? (
          <p className="text-xs text-muted-foreground">Open a chat to adjust parameters.</p>
        ) : (
          <div className="space-y-6">
            <div className="flex items-start gap-1.5 rounded-lg bg-foreground/[0.04] px-2.5 py-2 text-[11px] text-foreground/65">
              <Info className="mt-0.5 h-3 w-3 shrink-0 text-foreground/45" />
              <span className="leading-snug">{sourceLabel}</span>
            </div>

            {/* Thinking — placed above Sampling because it's a coarser
                "what kind of answer do I want?" lever, while Sampling is
                fine-grained "how does the model decide each token?". The
                row stays visible on every chat so users learn it exists,
                but the toggle itself is disabled (and visibly muted) when
                the active model doesn't list `thinking` in its
                `/api/show` capabilities — flipping it would just be
                ignored by Ollama, so we make that obvious upfront. */}
            <Section title="Thinking">
              <ThinkingRow
                checked={
                  // For supporting models the in-memory `think` from
                  // params drives the switch. `undefined` means "no
                  // explicit override" — for thinking-capable models the
                  // implicit default is ON (Ollama's behaviour for those
                  // models), so we surface that as ON.
                  params.think ?? supportsThinking
                }
                disabled={!supportsThinking}
                disabledHint={
                  isOpenAI
                    ? "Ignored by OpenAI providers — chain-of-thought is internal to the model."
                    : modelCapabilities === undefined
                      ? "Loading model capabilities…"
                      : "This model doesn't support a thinking step."
                }
                onChange={(next) => update({ think: next })}
              />
            </Section>

            <Section title="Sampling">
              <SliderRow
                label="Temperature"
                value={Math.min(params.temperature ?? 0.7, 1)}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => update({ temperature: v })}
                hint="Higher values make output more creative and diverse; lower values stay focused and deterministic. Values above 1.0 typically produce incoherent output, so the range is capped at 1."
              />
              <SliderRow
                label="Top-P"
                value={params.top_p ?? 0.95}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => update({ top_p: v })}
                hint="Sample from the smallest set of tokens whose combined probability reaches this value."
              />
              <SliderRow
                label="Top-K"
                value={params.top_k ?? 40}
                min={0}
                max={200}
                step={1}
                precision={0}
                onChange={(v) => update({ top_k: Math.round(v) })}
                hint={`Only consider the ${params.top_k ?? 40} most likely tokens at each step (0 disables the cutoff)${isOpenAI ? " — ignored by OpenAI providers" : ""}.`}
                dimmed={isOpenAI}
              />
              <SliderRow
                label="Min-P"
                value={params.min_p ?? 0.05}
                min={0}
                max={0.5}
                step={0.01}
                onChange={(v) => update({ min_p: v })}
                hint={`Drop any token whose probability is below this fraction of the top token's probability${isOpenAI ? " — ignored by OpenAI providers" : ""}.`}
                dimmed={isOpenAI}
              />
            </Section>

            <Section title="Length">
              <SliderRow
                label="Max Tokens"
                value={params.max_tokens ?? 4096}
                min={128}
                max={32768}
                step={128}
                precision={0}
                onChange={(v) => update({ max_tokens: Math.round(v) })}
                hint="Upper bound on the number of tokens the model may generate in a single reply."
              />
              <SliderRow
                label="Context Length"
                value={params.num_ctx ?? 8192}
                min={0}
                max={0}
                step={1}
                onChange={(v) => update({ num_ctx: Math.round(v) })}
                stops={CTX_STOPS}
                format={formatK}
                hint={
                  isOpenAI
                    ? "How many tokens of history the model sees — ignored by OpenAI providers (the server decides)."
                    : "How many tokens of history the model sees. Each step doubles the window; higher values use more VRAM."
                }
                dimmed={isOpenAI}
              />
            </Section>

            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-xs font-medium uppercase tracking-[0.12em] text-foreground/55 transition-colors hover:text-foreground/80"
            >
              <span>Advanced</span>
              {advancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>

            {advancedOpen && (
              <div className="space-y-6">
                <Section title="Repetition">
                  <SliderRow
                    label="Repeat Penalty"
                    value={params.repeat_penalty ?? 1.1}
                    min={0.8}
                    max={2}
                    step={0.05}
                    onChange={(v) => update({ repeat_penalty: v })}
                    hint={`Penalizes tokens seen in recent context to reduce loops; 1.0 disables it${isOpenAI ? " — ignored by OpenAI providers" : ""}.`}
                    dimmed={isOpenAI}
                  />
                  <SliderRow
                    label="Frequency Penalty"
                    value={params.frequency_penalty ?? 0}
                    min={-2}
                    max={2}
                    step={0.05}
                    onChange={(v) => update({ frequency_penalty: v })}
                    hint="Scales down tokens proportional to how often they've already appeared in this reply."
                  />
                  <SliderRow
                    label="Presence Penalty"
                    value={params.presence_penalty ?? 0}
                    min={-2}
                    max={2}
                    step={0.05}
                    onChange={(v) => update({ presence_penalty: v })}
                    hint="Flat penalty applied to any token that has already appeared at least once."
                  />
                </Section>

                <Section title="Performance">
                  <GpuLayersRow
                    value={params.num_gpu ?? null}
                    onChange={(num_gpu) =>
                      update({ num_gpu: num_gpu ?? undefined })
                    }
                    isOpenAI={isOpenAI}
                  />
                  <LowVramRow
                    checked={
                      // Global pin wins above everything — show that state
                      // honestly so users don't think their per-chat toggle
                      // is broken when it's actually being overridden.
                      lowVramGlobal && !isOpenAI
                        ? true
                        : (params.low_vram ?? false)
                    }
                    onChange={(next) =>
                      update({ low_vram: next ? true : undefined })
                    }
                    isOpenAI={isOpenAI}
                    pinnedByGlobal={lowVramGlobal && !isOpenAI}
                  />
                </Section>

                <Section title="Reproducibility">
                  <SeedRow
                    value={params.seed ?? null}
                    onChange={(seed) => update({ seed })}
                  />
                </Section>
              </div>
            )}

            <div className="flex justify-start pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetParams}
                disabled={!hasOverrides}
                className="h-7 gap-1.5 rounded-md px-2 text-[11px] font-medium text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
                title={
                  hasModelDefaults
                    ? "Drop your overrides and follow this model's Modelfile defaults again."
                    : "Drop your overrides and follow the app defaults again."
                }
              >
                <RotateCcw className="h-3 w-3" />
                {hasModelDefaults ? "Reset to model defaults" : "Reset to defaults"}
              </Button>
            </div>

            <div className="h-px bg-foreground/[0.08]" />

            <div>
              <Label
                htmlFor="session-system-prompt"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground/70"
              >
                System prompt (this chat)
              </Label>
              <Textarea
                id="session-system-prompt"
                rows={5}
                placeholder="Override the global system prompt for this chat…"
                className="mt-2 resize-none border-foreground/10 bg-foreground/[0.04] text-sm focus-visible:border-foreground/25 focus-visible:ring-0"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onBlur={() =>
                  session && setSessionSystemPrompt(session.id, systemPrompt)
                }
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/50">
                Only applies to this conversation; leave empty to use the global prompt.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground/70">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/**
 * Single-row layout used by the "Thinking" section. Same visual rhythm as
 * a SliderRow (label on the left, control on the right) so the panel
 * feels consistent. Disabled state mutes the row but keeps the label
 * legible — users still get the affordance + a hint about WHY it's off.
 */
function ThinkingRow({
  checked,
  disabled,
  disabledHint,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  disabledHint: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={disabled ? "opacity-55" : undefined}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
          <Label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">
            Thinking
          </Label>
        </div>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={checked ? "Disable thinking" : "Enable thinking"}
        />
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-foreground/50">
        {disabled
          ? disabledHint
          : "Let the model reason step-by-step before replying. Adds latency for long answers but may improve quality on complex prompts."}
      </p>
    </div>
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
  dimmed,
  stops,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  precision?: number;
  onChange: (v: number) => void;
  hint?: string;
  dimmed?: boolean;
  /** When present the slider snaps to these discrete values instead of sliding continuously between `min` and `max`. */
  stops?: number[];
  /** Custom display formatter; default is `value.toFixed(precision)`. */
  format?: (v: number) => string;
}) {
  const usingStops = stops && stops.length > 0;

  // Find the stop index closest to the current value so a pre-existing
  // legacy value (e.g. 6144 from before the stops migration) lands sensibly.
  const stopIdx = usingStops
    ? (() => {
        let best = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < stops!.length; i++) {
          const d = Math.abs(stops![i] - value);
          if (d < bestDiff) {
            bestDiff = d;
            best = i;
          }
        }
        return best;
      })()
    : 0;
  const displayValue = usingStops ? stops![stopIdx] : value;
  const displayText = format
    ? format(displayValue)
    : displayValue.toFixed(precision);

  return (
    <div className={dimmed ? "opacity-55" : undefined}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <Label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">
          {label}
        </Label>
        <span className="font-mono text-xs tabular-nums text-foreground/85">
          {displayText}
        </span>
      </div>
      {usingStops ? (
        <Slider
          value={[stopIdx]}
          min={0}
          max={stops!.length - 1}
          step={1}
          onValueChange={(v) => onChange(stops![v[0]])}
        />
      ) : (
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => onChange(v[0])}
        />
      )}
      {hint && (
        <p className="mt-1.5 text-[10.5px] leading-snug text-foreground/50">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * GPU layer offload (`num_gpu`). Three states the user lands in:
 *
 *   - **Auto** (`value === null`) — the field is blank, Ollama auto-detects
 *     based on available VRAM. The default for every chat unless either
 *     the user overrides it or the model's Modelfile lists `num_gpu`.
 *   - **CPU only** (`value === 0`) — useful for testing CPU paths or when
 *     even one layer on GPU OOMs the system.
 *   - **Custom** (`value > 0`) — user explicitly picks how many layers
 *     to offload. Useful when a model that *almost* fits has its KV cache
 *     pushed off the GPU; cutting layers leaves room.
 *
 * No upper bound is enforced — the layer count is model-specific (some
 * have 32, others 80+) and Ollama caps to the actual count anyway.
 */
function GpuLayersRow({
  value,
  onChange,
  isOpenAI,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  isOpenAI: boolean;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) onChange(n);
  };

  const readout =
    value === null ? "auto" : value === 0 ? "CPU only" : `${value} layers`;

  return (
    <div className={isOpenAI ? "opacity-55" : undefined}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <Label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">
          <Layers className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
          GPU Layers
        </Label>
        <span className="font-mono text-[10px] text-foreground/45">
          {readout}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="Auto"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
              (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={isOpenAI}
          className="h-8 border-foreground/10 bg-foreground/[0.04] text-sm tabular-nums focus-visible:border-foreground/25 focus-visible:ring-0"
        />
        {value !== null && !isOpenAI && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-md text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
            onClick={() => {
              setDraft("");
              onChange(null);
            }}
            title="Clear (let Ollama auto-detect)"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-foreground/50">
        {isOpenAI
          ? "Ignored by OpenAI providers — server-side decision."
          : "How many model layers to offload to the GPU. 0 = CPU only; leave blank for Ollama's auto-detect."}
      </p>
    </div>
  );
}

/**
 * Low-VRAM toggle. Sends `low_vram: true` to Ollama, which trades
 * throughput for footprint (smaller batches, leaner KV cache). Off by
 * default — only flip when you're hitting OOMs and `num_gpu` alone
 * isn't enough. We persist `undefined` instead of `false` so a session
 * that hasn't touched the toggle reads as "no override".
 *
 * `pinnedByGlobal` reflects the Settings → General master switch. When
 * true, the per-chat toggle is forced on and disabled — flipping it
 * would be a no-op, so we make that obvious instead of silently ignoring
 * the click.
 */
function LowVramRow({
  checked,
  onChange,
  isOpenAI,
  pinnedByGlobal,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  isOpenAI: boolean;
  pinnedByGlobal: boolean;
}) {
  const disabled = isOpenAI || pinnedByGlobal;
  return (
    <div className={disabled ? "opacity-55" : undefined}>
      <div className="flex items-center justify-between gap-3">
        <Label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">
          <MemoryStick className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
          Low VRAM
        </Label>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={checked ? "Disable low VRAM mode" : "Enable low VRAM mode"}
        />
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-foreground/50">
        {isOpenAI
          ? "Ignored by OpenAI providers."
          : pinnedByGlobal
            ? "Pinned on by the global Low VRAM setting (Settings → General). Turn that off to control it per chat."
            : "Trade speed for memory: smaller batches and KV cache. Helpful when you're up against VRAM limits."}
      </p>
    </div>
  );
}

function SeedRow({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n) && Number.isInteger(n)) onChange(n);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <Label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">
          Seed
        </Label>
        <span className="font-mono text-[10px] text-foreground/45">
          {value === null ? "random" : "fixed"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="Random"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="h-8 border-foreground/10 bg-foreground/[0.04] text-sm tabular-nums focus-visible:border-foreground/25 focus-visible:ring-0"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-md text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
          onClick={() => {
            const n = Math.floor(Math.random() * 2_000_000_000);
            setDraft(String(n));
            onChange(n);
          }}
          title="Generate a random seed"
        >
          <Dice5 className="h-4 w-4" />
        </Button>
        {value !== null && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-md text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
            onClick={() => {
              setDraft("");
              onChange(null);
            }}
            title="Clear seed (use random each run)"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-foreground/50">
        Use a fixed integer to make the model's output reproducible; leave empty for a fresh random seed each run.
      </p>
    </div>
  );
}
