import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronRight, Dice5, Info, Layers, MemoryStick, RotateCcw, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import {
  DEFAULT_PERSONA_ID,
  PERSONAS,
  getPersona,
  type Persona,
} from "@/lib/personas";
import { DEFAULT_TONE_ID, TONES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";
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
  // Persona id for the active chat. The picker writes the seed text into the
  // session's `system_prompt` AND stamps the id here so the active pill stays
  // visible on subsequent panel opens. If the user then manually edits the
  // textarea below, the id clears (handled in the textarea onBlur) so the
  // pill row never shows a stale "Active" badge for a prompt that no longer
  // matches.
  const activePersonaId = useUIStore((s) =>
    session ? s.personaIdBySession[session.id] : undefined,
  );
  const setSessionPersona = useUIStore((s) => s.setSessionPersona);
  // Tone — per-chat override; falls back to settings.default_tone_id when
  // the user hasn't picked one for this chat. The pill row reflects the
  // *effective* tone so the user always sees what the next send will use.
  const activeToneId = useUIStore((s) =>
    session ? s.toneIdBySession[session.id] : undefined,
  );
  const setSessionTone = useUIStore((s) => s.setSessionTone);
  const defaultToneId = useSettingsStore((s) => s.default_tone_id);
  const effectiveToneId = activeToneId ?? defaultToneId ?? DEFAULT_TONE_ID;

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
  // Global Thinking default (Settings → General). Mirrors the chatStore
  // merge order so the panel shows the same value the request will send.
  const thinkingDefault = useSettingsStore((s) => s.thinking_default);

  const overrides = useMemo(
    () => parseOverrides(session?.params_json ?? null),
    [session?.params_json],
  );
  const hasOverrides = Object.keys(overrides).length > 0;

  // Space-level defaults, subscribed by value so the panel re-merges when the
  // Space's pinned params change under it.
  const spaceParamsJson = useSpaceStore((s) =>
    session?.space_id
      ? s.spaces.find((x) => x.id === session.space_id)?.default_params_json ??
        null
      : null,
  );
  const spaceLayer = useMemo(
    () => parseOverrides(spaceParamsJson),
    [spaceParamsJson],
  );

  // The merge order mirrors `chatStore.readSessionParams` exactly so the
  // sliders (and the Thinking toggle) show the same values the request
  // will actually use. The space layer matters twice over: without it the
  // panel shows values the request won't use for any chat in a Space with
  // pinned params, AND `update()` below snapshots what's displayed into the
  // per-chat override — so one slider touch would quietly overwrite the
  // Space's settings with the space-less merge.
  const initial = useMemo<GenerationParams>(
    () => ({
      ...DEFAULT_PARAMS,
      ...(session?.provider === "ollama" ? { think: thinkingDefault } : {}),
      ...(modelDefaults ?? {}),
      ...(modelThinkPref === undefined ? {} : { think: modelThinkPref }),
      ...spaceLayer,
      ...overrides,
    }),
    [
      overrides,
      spaceLayer,
      modelDefaults,
      modelThinkPref,
      thinkingDefault,
      session?.provider,
    ],
  );

  // Only the keys the user has actually touched in this panel session are held
  // locally; every other value is read live off `initial`. Holding a full
  // merged snapshot instead froze whatever the layers happened to be at mount
  // — and `modelDefaults` is fetched fire-and-forget (cold on every app start),
  // so that snapshot was routinely taken before the Modelfile values existed.
  // The sliders then showed app defaults while the source label below already
  // read "using the Modelfile's", and since `update()` persists the whole
  // displayed set, a single slider touch wrote e.g. num_ctx 8192 over the
  // Modelfile's 32768 for the rest of the chat's life.
  const [touched, setTouched] = useState<Partial<GenerationParams>>({});
  const params = useMemo<GenerationParams>(
    () => ({ ...initial, ...touched }),
    [initial, touched],
  );
  const [systemPrompt, setSystemPrompt] = useState(session?.system_prompt ?? "");
  // Persisted across sessions — most users settle on one mode and don't
  // want to reselect it every time the panel opens. Stored in localStorage
  // directly to avoid bloating the UI store with a single string.
  const [viewMode, setViewMode] = useState<"simple" | "advanced">(() => {
    if (typeof window === "undefined") return "simple";
    return window.localStorage.getItem("parameterPanel.viewMode") === "advanced"
      ? "advanced"
      : "simple";
  });
  const isAdvanced = viewMode === "advanced";

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("parameterPanel.viewMode", viewMode);
  }, [viewMode]);

  // Drop this panel's edits when it switches to a different chat. Only the
  // session id matters: `params` recomputes from `initial` on its own, so
  // there's no snapshot to refresh and no way for a layer change to revert an
  // in-flight drag (the failure the older full-snapshot version had, where a
  // re-seed triggered by persisting slider A reverted an in-flight slider B).
  const seededFor = useRef<string | null>(null);
  // What we last pushed into the textarea, so an external rewrite can be told
  // apart from the user's own typing.
  const seededPrompt = useRef(session?.system_prompt ?? "");
  useEffect(() => {
    const id = session?.id ?? null;
    if (seededFor.current === id) return;
    seededFor.current = id;
    setTouched({});
    seededPrompt.current = session?.system_prompt ?? "";
    setSystemPrompt(session?.system_prompt ?? "");
    // `session?.system_prompt` is read through the closure on purpose — this
    // effect is about switching chats, and the effect below owns adopting an
    // external edit to the prompt of the chat we're already on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Adopt a system prompt rewritten from outside the panel — compaction stuffs
  // its auto-summary block in there. Without this the textarea kept its
  // pre-compaction copy and the next blur wrote that stale text straight back,
  // deleting the summary. Skipped while the textarea is dirty: the user's
  // unsaved edit wins, and their blur persists it.
  useEffect(() => {
    const incoming = session?.system_prompt ?? "";
    if (incoming === seededPrompt.current) return;
    if (systemPrompt !== seededPrompt.current) return;
    seededPrompt.current = incoming;
    setSystemPrompt(incoming);
  }, [session?.system_prompt, systemPrompt]);

  // Defensive — newSession / setSessionModel already prefetch, but the panel
  // can also be opened on a session created before this code shipped.
  useEffect(() => {
    if (session?.provider === "ollama" && session.model && !modelDefaults) {
      void loadModelDefaults(session.model);
    }
  }, [session?.provider, session?.model, modelDefaults, loadModelDefaults]);

  const update = (patch: Partial<GenerationParams>) => {
    if (!session) return;
    // Built from `params`, which is the LIVE layer stack plus this panel's
    // edits — not a snapshot taken at mount. Touching any slider still
    // persists the whole effective set into the session's overrides, so a
    // later model swap doesn't silently shift values the user was looking at.
    const next = { ...params, ...patch };
    setTouched((t) => ({ ...t, ...patch }));
    setSessionParams(session.id, next);
  };

  // Quick-pick handlers — both just record the picked id. Their text is
  // layered into the system prompt at send time (chatStore), so the textarea
  // below stays purely user-authored. Switching personas or tones never
  // touches the textarea, and editing the textarea never drifts the pickers.
  const pickTone = (toneId: string) => {
    if (!session) return;
    setSessionTone(session.id, toneId);
  };

  const pickPersona = (personaId: string) => {
    if (!session) return;
    if (!getPersona(personaId)) return;
    setSessionPersona(session.id, personaId);
  };

  // Reset clears the override entirely so the session falls back to (space
  // defaults + model defaults + app defaults). For Ollama models the model
  // layer is the Modelfile values; for OpenAI it's just app defaults. The
  // space layer stays because clearing a per-chat override doesn't leave the
  // Space — displaying it without would restate the same lie `initial` fixes.
  const resetParams = () => {
    if (!session) return;
    // Just drop this panel's edits and the stored override — `initial`
    // recomputes to exactly the layer stack below them, and `setSessionParams`
    // updates the store optimistically, so the sliders land on the right
    // values in the same render without re-deriving the merge by hand here.
    setTouched({});
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
  const CTX_STOPS = [
    4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
  ];
  const formatK = (n: number) => {
    if (n >= 1024 * 1024) {
      const m = n / 1024 / 1024;
      return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
    }
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
            <Tabs
              value={viewMode}
              onValueChange={(v) => setViewMode(v as "simple" | "advanced")}
            >
              <TabsList className="grid h-8 w-full grid-cols-2 rounded-xl p-0.5 text-[11px]">
                <TabsTrigger
                  value="simple"
                  className="rounded-lg px-2 py-1 text-[11px] font-medium"
                >
                  Simple
                </TabsTrigger>
                <TabsTrigger
                  value="advanced"
                  className="rounded-lg px-2 py-1 text-[11px] font-medium"
                >
                  Advanced
                </TabsTrigger>
              </TabsList>
            </Tabs>

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
            {/* No <Section> wrapper: ThinkingRow is self-labeling (icon +
                "Thinking" + switch), so a "THINKING" section header above it
                would just duplicate the row's own label. */}
            <ThinkingRow
              checked={
                // Disabled rows (unsupported model / OpenAI) always read
                // as OFF so the toggle never shows an "on" state next to a
                // "doesn't support a thinking step" caption. For supporting
                // models the in-memory `think` drives the switch;
                // `undefined` means "no explicit override", which for
                // thinking-capable models is implicitly ON (Ollama's
                // behaviour), so we surface that as ON.
                supportsThinking && (params.think ?? true)
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

            {isAdvanced && (
              <Section title="Sampling">
                <SliderRow
                  label="Temperature"
                  value={Math.min(params.temperature ?? 0.7, 1)}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => update({ temperature: v })}
                  hint="Controls randomness. Lower stays focused and predictable; higher gets more creative and varied. Capped at 1 — beyond that, output usually breaks down."
                />
                <SliderRow
                  label="Top-P"
                  value={params.top_p ?? 0.95}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => update({ top_p: v })}
                  hint="Nucleus sampling. Pick from the smallest group of tokens whose probabilities add up to this value. Lower stays on-track; higher allows more variety."
                />
                <SliderRow
                  label="Top-K"
                  value={params.top_k ?? 40}
                  min={0}
                  max={200}
                  step={1}
                  precision={0}
                  onChange={(v) => update({ top_k: Math.round(v) })}
                  hint={`Only consider the K most likely tokens at each step. Lower is more focused; 0 disables the cap${isOpenAI ? ". Ignored by OpenAI providers" : ""}.`}
                  dimmed={isOpenAI}
                />
                <SliderRow
                  label="Min-P"
                  value={params.min_p ?? 0.05}
                  min={0}
                  max={0.5}
                  step={0.01}
                  onChange={(v) => update({ min_p: v })}
                  hint={`Drop any token whose probability is below this fraction of the top token's. A robust alternative to tuning Top-P/K${isOpenAI ? ". Ignored by OpenAI providers" : ""}.`}
                  dimmed={isOpenAI}
                />
              </Section>
            )}

            <Section title="Length">
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
                    ? "How much conversation history the model can see at once. Ignored by OpenAI providers — the server decides."
                    : "How much conversation history the model can see at once. Larger windows remember more but use more VRAM."
                }
                dimmed={isOpenAI}
              />
              {isAdvanced && (
                <SliderRow
                  label="Max Tokens"
                  value={params.max_tokens ?? 4096}
                  min={128}
                  max={32768}
                  step={128}
                  precision={0}
                  onChange={(v) => update({ max_tokens: Math.round(v) })}
                  hint="Hard cap on the length of a single reply. Generation stops here even if the model isn't finished."
                />
              )}
            </Section>

            {isAdvanced && (
              <Section title="Repetition">
                <SliderRow
                  label="Repeat Penalty"
                  value={params.repeat_penalty ?? 1.1}
                  min={0.8}
                  max={2}
                  step={0.05}
                  onChange={(v) => update({ repeat_penalty: v })}
                  hint={`Discourages the model from looping by penalizing tokens it's just used. 1.0 is off; much above 1.3 starts to sound robotic${isOpenAI ? ". Ignored by OpenAI providers" : ""}.`}
                  dimmed={isOpenAI}
                />
                <SliderRow
                  label="Frequency Penalty"
                  value={params.frequency_penalty ?? 0}
                  min={-2}
                  max={2}
                  step={0.05}
                  onChange={(v) => update({ frequency_penalty: v })}
                  hint="Pushes down tokens in proportion to how often they've already appeared in this reply. Negative values do the opposite and encourage repetition."
                />
                <SliderRow
                  label="Presence Penalty"
                  value={params.presence_penalty ?? 0}
                  min={-2}
                  max={2}
                  step={0.05}
                  onChange={(v) => update({ presence_penalty: v })}
                  hint="A flat one-time penalty for any token that has already appeared. Nudges the model toward fresh vocabulary and new topics."
                />
              </Section>
            )}

            <Section title="Performance">
              {isAdvanced && (
                <GpuLayersRow
                  value={params.num_gpu ?? null}
                  onChange={(num_gpu) =>
                    update({ num_gpu: num_gpu ?? undefined })
                  }
                  isOpenAI={isOpenAI}
                />
              )}
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

            {isAdvanced && (
              <Section title="Reproducibility">
                <SeedRow
                  value={params.seed ?? null}
                  onChange={(seed) => update({ seed })}
                />
              </Section>
            )}

            <div className="pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={resetParams}
                disabled={!hasOverrides}
                className="h-8 w-full gap-1.5 rounded-lg border-foreground/20 bg-foreground/[0.04] px-3 text-[11px] font-semibold text-foreground/90 hover:border-foreground/30 hover:bg-foreground/[0.10] hover:text-foreground disabled:opacity-40"
                title={
                  hasModelDefaults
                    ? "Drop your overrides and follow this model's Modelfile defaults again."
                    : "Drop your overrides and follow the app defaults again."
                }
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {hasModelDefaults ? "Reset to model defaults" : "Reset to defaults"}
              </Button>
            </div>

            <div className="h-px bg-foreground/[0.08]" />

            <div>
              <Label className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground/70">
                Persona
              </Label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {PERSONAS.map((p) => (
                  <PersonaPill
                    key={p.id}
                    persona={p}
                    active={
                      activePersonaId
                        ? activePersonaId === p.id
                        : p.id === DEFAULT_PERSONA_ID
                    }
                    onClick={() => pickPersona(p.id)}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/50">
                Defines the assistant's role. Layered into the system prompt at send time.
              </p>
            </div>

            <div>
              <Label className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground/70">
                Tone
              </Label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TONES.map((t) => (
                  <TonePill
                    key={t.id}
                    tone={t}
                    active={effectiveToneId === t.id}
                    onClick={() => pickTone(t.id)}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/50">
                Style modifier appended after the system prompt. Falls back to your global default in Settings → General when not set here.
              </p>
            </div>

            <div>
              <Label
                htmlFor="session-system-prompt"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground/70"
              >
                Additional instructions (this chat)
              </Label>
              <Textarea
                id="session-system-prompt"
                rows={5}
                placeholder="Extra instructions for this chat — sit between the persona and the tone…"
                className="mt-2 resize-none border-foreground/10 bg-foreground/[0.04] text-sm focus-visible:border-foreground/25 focus-visible:ring-0"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onBlur={() => {
                  if (!session) return;
                  // The textarea is clean again once saved, so mark this as
                  // the seeded value — otherwise the effect above would read
                  // it as an unsaved edit forever and never adopt a later
                  // external rewrite (e.g. compaction's summary block).
                  seededPrompt.current = systemPrompt;
                  setSessionSystemPrompt(session.id, systemPrompt);
                }}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/50">
                Free-form per-chat instructions. Layered between persona and tone — leave empty to fall back to the global custom instructions.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// Compact persona quick-pick pill. The active state carries the same
// `--primary` tint as the composer's PersonaChip so the two surfaces agree —
// a user who picks "Code Reviewer" here and then glances at the composer
// sees the same accent on the chip above the textarea.
function PersonaPill({
  persona,
  active,
  onClick,
}: {
  persona: Persona;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = persona.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={persona.description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
        active
          ? "border-primary/50 bg-primary/10 font-semibold text-foreground"
          : "border-foreground/10 bg-foreground/[0.04] font-medium text-foreground/75 hover:border-foreground/25 hover:bg-foreground/[0.08] hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {persona.label}
    </button>
  );
}

// Tone reuses the persona pill shape and accent so the two sections feel
// part of the same picker family — same shape, same active tint.
function TonePill({
  tone,
  active,
  onClick,
}: {
  tone: Tone;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = tone.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={tone.description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
        active
          ? "border-primary/50 bg-primary/10 font-semibold text-foreground"
          : "border-foreground/10 bg-foreground/[0.04] font-medium text-foreground/75 hover:border-foreground/25 hover:bg-foreground/[0.08] hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {tone.label}
    </button>
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

  // Local drag position so dragging updates the thumb + readout live WITHOUT
  // persisting on every pointermove. `onChange` (which clones the sessions
  // array and writes to SQLite over IPC) now fires only on `onValueCommit` —
  // pointer-up or a key press — so a one-second drag is a single write, not
  // the 60-120 it used to spray. `null` = not dragging; fall back to the
  // prop-derived position.
  const [drag, setDrag] = useState<number | null>(null);

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
  // Live slider position: the in-flight drag value while dragging, else derived
  // from props (`stopIdx` for stops, the raw `value` for continuous).
  const pos = drag ?? (usingStops ? stopIdx : value);
  const displayValue = usingStops ? stops![pos] : pos;
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
          value={[pos]}
          min={0}
          max={stops!.length - 1}
          step={1}
          onValueChange={(v) => setDrag(v[0])}
          onValueCommit={(v) => {
            onChange(stops![v[0]]);
            setDrag(null);
          }}
        />
      ) : (
        <Slider
          value={[pos]}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => setDrag(v[0])}
          onValueCommit={(v) => {
            onChange(v[0]);
            setDrag(null);
          }}
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
