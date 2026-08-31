import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelsStore, type AdminProgress } from "@/stores/modelsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import {
  openExternal,
  ollamaListModels,
  ollamaStart,
  openaiListModels,
  systemInfo,
} from "@/lib/tauri";
import {
  bytesToGb,
  classifyFit,
  formatGb,
  rankChatModels,
  recommendVariant,
  type FitVerdict,
  type HostCapacity,
} from "@/lib/modelChoice";
import type { ModelInfo, ProviderId } from "@/types";
import { cn, prefersReducedMotion } from "@/lib/utils";
import { StepShell } from "./StepShell";

/**
 * Provider configuration — the only step the user can't skip past
 * without consequence. Two flows live here side by side:
 *
 *   - Ollama: probe `/api/tags`. If the daemon already lists models we show
 *     them in a default-model picker and unblock Continue. If it's running
 *     but empty we size the recommended catalog against the machine's RAM
 *     and lead with one suggestion. If it isn't answering at all we offer to
 *     start it, and keep re-probing in the background so a user who leaves to
 *     install Ollama comes back to a green panel instead of a stale warning.
 *     Pulls run inline and the user can keep onboarding while one finishes —
 *     `PullStrip` (in StepShell) follows the download through the rest of the
 *     wizard, and `ModelDownloadBanner` takes over in the chat.
 *
 *   - OpenAI API: base URL + key. Saving runs `openai_list_models` as
 *     a connectivity probe; a 401 / network error blocks Continue and
 *     surfaces inline. The returned catalog feeds the same default-model
 *     picker.
 *
 * The X behaviour (`onCloseRequest`) bubbles up to the controller so
 * it can show the "Skip setup?" confirmation; the local state stays
 * intact in case the user cancels the dismiss.
 */

type Phase = "choose" | "ollama" | "openai";

interface CatalogVariant {
  tag: string;
  label: string;
  /** On-disk footprint after the pull, in GB. Numeric (not a display string)
   *  because `modelChoice` sizes it against the host's RAM. */
  sizeGb: number;
}

// Recommended Ollama catalog. Sizes are rough disk-footprint estimates so
// users can budget; exact bytes come back during the pull stream.
//
// Parameter sizes only: a family's quantization and format tags (q4_K_M, q8_0,
// bf16, mlx, mxfp8, nvfp4, …) are deliberately left out. Several families ship
// a single parameter size and a dozen quant variants of it, and listing those
// would rebuild exactly the wall of near-identical options this step exists to
// spare a newcomer — a one-variant family here is complete, not truncated.
// The custom-tag field below covers anyone who wants a specific quant.
const OLLAMA_CATALOG: {
  family: string;
  url: string;
  variants: CatalogVariant[];
}[] = [
  {
    family: "Gemma 4",
    url: "https://ollama.com/library/gemma4",
    variants: [
      { tag: "gemma4:e2b", label: "E2B", sizeGb: 7.2 },
      { tag: "gemma4:e4b", label: "E4B", sizeGb: 9.6 },
      { tag: "gemma4:12b", label: "12B", sizeGb: 7.6 },
      { tag: "gemma4:26b", label: "26B (MoE)", sizeGb: 18 },
      { tag: "gemma4:31b", label: "31B", sizeGb: 20 },
    ],
  },
  {
    family: "Qwen 3.5",
    url: "https://ollama.com/library/qwen3.5",
    variants: [
      { tag: "qwen3.5:0.8b", label: "0.8B", sizeGb: 1 },
      { tag: "qwen3.5:2b", label: "2B", sizeGb: 2.7 },
      { tag: "qwen3.5:4b", label: "4B", sizeGb: 3.4 },
      { tag: "qwen3.5:9b", label: "9B", sizeGb: 6.6 },
      { tag: "qwen3.5:27b", label: "27B", sizeGb: 17 },
      { tag: "qwen3.5:35b", label: "35B (MoE)", sizeGb: 24 },
      { tag: "qwen3.5:122b", label: "122B (MoE)", sizeGb: 81 },
    ],
  },
  {
    family: "Qwen 3.6",
    url: "https://ollama.com/library/qwen3.6",
    variants: [
      { tag: "qwen3.6:27b", label: "27B", sizeGb: 17 },
      { tag: "qwen3.6:35b", label: "35B (MoE)", sizeGb: 24 },
    ],
  },
  {
    family: "Qwen 3.8",
    url: "https://ollama.com/library/qwen3.8",
    variants: [{ tag: "qwen3.8:27b", label: "27B", sizeGb: 18 }],
  },
  {
    family: "Ministral 3",
    url: "https://ollama.com/library/ministral-3",
    variants: [
      { tag: "ministral-3:3b", label: "3B", sizeGb: 3 },
      { tag: "ministral-3:8b", label: "8B", sizeGb: 6 },
      { tag: "ministral-3:14b", label: "14B", sizeGb: 9.1 },
    ],
  },
  {
    family: "Nemotron 3.5 Lightning",
    url: "https://ollama.com/library/nemotron-3.5-lightning",
    // NVIDIA's 30B MoE with 3B active per token — the `a3b` in its other tags.
    // MoE cuts compute per token, not residency: all 30B of weights still have
    // to be held, so it is sized against RAM like any other 25 GB download.
    variants: [
      { tag: "nemotron-3.5-lightning:30b", label: "30B (MoE)", sizeGb: 25 },
    ],
  },
  {
    family: "Muse Glimmer",
    url: "https://ollama.com/library/muse-glimmer",
    variants: [{ tag: "muse-glimmer:30b", label: "30B", sizeGb: 18 }],
  },
];

const ALL_VARIANTS: CatalogVariant[] = OLLAMA_CATALOG.flatMap((f) => f.variants);

/** Read the host's RAM / free disk once per mount. Null while in flight, and
 *  stays null outside the Tauri shell or if the probe fails — every consumer
 *  treats that as "no fit hints", never as "zero RAM". */
function useHostCapacity(): HostCapacity | null {
  const [host, setHost] = useState<HostCapacity | null>(null);
  useEffect(() => {
    let cancelled = false;
    void systemInfo()
      .then((info) => {
        if (cancelled || !info) return;
        setHost({
          totalRamBytes: info.total_ram_bytes,
          freeDiskBytes: info.free_disk_bytes,
        });
      })
      .catch(() => {
        /* No hardware hints — the catalog still works unaided. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return host;
}

export function ProviderStep({
  onClose,
}: {
  onClose: () => void;
}) {
  const goNext = useOnboardingStore((s) => s.goNext);
  const goBack = useOnboardingStore((s) => s.goBack);

  const [phase, setPhase] = useState<Phase>("choose");
  // Tracks whether the user has done enough on the chosen path to advance.
  // Ollama: at least one model present (whether pre-existing, just pulled,
  // or pull in flight). OpenAI: key validated.
  const [provisioned, setProvisioned] = useState(false);

  return (
    <StepShell
      step="provider"
      title="Pick a provider"
      subtitle="Loach can run local models through Ollama or talk to any OpenAI-compatible API."
      primaryLabel="Continue"
      primaryDisabled={!provisioned}
      // Say why Continue is dead instead of leaving a greyed-out mystery.
      // Phrased around the unlock condition (not a specific action) so it
      // stays true whether Ollama is down or merely empty. The ✕ route
      // through "Skip setup?" stays available on every branch.
      primaryHint={
        phase === "ollama"
          ? "Continue unlocks once Ollama has a model — or close (✕) to finish setup later."
          : phase === "openai"
            ? "Continue unlocks once a key is verified — or close (✕) to finish setup later."
            : "Pick a provider to continue — or close (✕) to finish setup later."
      }
      onPrimary={goNext}
      canGoBack={phase === "choose"}
      onBack={goBack}
      onClose={onClose}
    >
      {phase === "choose" ? (
        <ProviderChoice
          onPick={(p) => {
            setPhase(p === "ollama" ? "ollama" : "openai");
          }}
        />
      ) : (
        <div className="space-y-4">
          <ProviderSwitch
            value={phase}
            onChange={(p) => {
              if (p === phase) return;
              setProvisioned(false);
              setPhase(p);
            }}
          />
          {phase === "ollama" ? (
            <OllamaPath onProvisioned={() => setProvisioned(true)} />
          ) : (
            <OpenAIPath onProvisioned={() => setProvisioned(true)} />
          )}
        </div>
      )}
    </StepShell>
  );
}

/* ───────────────────────── choose card row ───────────────────────── */

function ProviderChoice({ onPick }: { onPick: (p: ProviderId) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ProviderCard
        title="Ollama"
        tagline="Local · private · free"
        description="Run models on this machine."
        icon={<HardDrive className="h-5 w-5" />}
        recommended
        onClick={() => onPick("ollama")}
      />
      <ProviderCard
        title="OpenAI API"
        tagline="Cloud · pay-as-you-go"
        description="Use GPT, LM Studio, or any other OpenAI-compatible endpoint with your API key."
        icon={<Cloud className="h-5 w-5" />}
        onClick={() => onPick("openai")}
      />
    </div>
  );
}

function ProviderCard({
  title,
  tagline,
  description,
  icon,
  recommended,
  onClick,
}: {
  title: string;
  tagline: string;
  description: string;
  icon: React.ReactNode;
  recommended?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-start gap-2 rounded-2xl border-2 border-foreground/10 p-4 text-left transition-all",
        "hover:border-primary/40 hover:bg-foreground/[0.02] hover:-translate-y-0.5",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
      )}
    >
      {recommended && (
        <span className="absolute right-3 top-3 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          Recommended
        </span>
      )}
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.05] text-foreground/80 group-hover:bg-primary/10 group-hover:text-primary transition-colors">
        {icon}
      </span>
      <div>
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          {tagline}
        </p>
      </div>
      <p className="text-[12.5px] leading-relaxed text-foreground/60">
        {description}
      </p>
    </button>
  );
}

/* ───────────────────────── Ollama path ───────────────────────── */

type OllamaProbe =
  | { kind: "probing" }
  | { kind: "down"; error: string }
  | { kind: "up"; models: ModelInfo[] };

/** How often to silently re-probe while Ollama is unreachable. The expected
 *  journey out of that state is "leave, install Ollama, come back", so the
 *  panel has to heal itself — a user who never finds the Recheck button would
 *  otherwise sit in front of a warning that is no longer true. */
const REPROBE_MS = 3000;

function OllamaPath({ onProvisioned }: { onProvisioned: () => void }) {
  const baseUrl = useSettingsStore((s) => s.ollama_base_url);
  const update = useSettingsStore((s) => s.update);
  const setProviderDefault = useSettingsStore((s) => s.setProviderDefault);
  const pinnedModel = useSettingsStore((s) => s.default_model);
  const refreshModels = useModelsStore((s) => s.refresh);
  const host = useHostCapacity();

  const [probe, setProbe] = useState<OllamaProbe>({ kind: "probing" });
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Guards the background poll against stacking probes when a connect attempt
  // takes longer than the poll interval.
  const probing = useRef(false);

  const runProbe = async (opts?: { quiet?: boolean }) => {
    if (probing.current) return;
    probing.current = true;
    // A background poll must not flip the panel back to "Looking for…" every
    // few seconds — the user would watch it strobe between two states.
    if (!opts?.quiet) setProbe({ kind: "probing" });
    try {
      const list = await ollamaListModels(baseUrl);
      setProbe({ kind: "up", models: list });
      if (list.length > 0) {
        // Pre-existing models — pin the first as the default so Continue is
        // live immediately. Unlike before, the pick is *shown* in a picker
        // below, so it's a visible default rather than a silent one.
        await setProviderDefault("ollama", list[0].id);
        await refreshModels();
        onProvisioned();
      }
    } catch (e) {
      setProbe({
        kind: "down",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      probing.current = false;
    }
  };

  useEffect(() => {
    void runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  // Self-healing poll while unreachable. Torn down as soon as the probe
  // succeeds (or the user edits the URL, which re-runs the effect above).
  useEffect(() => {
    if (probe.kind !== "down") return;
    const id = window.setInterval(() => void runProbe({ quiet: true }), REPROBE_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe.kind, baseUrl]);

  const handleUrlSave = async () => {
    const next = urlDraft.trim();
    if (!next) return;
    await update("ollama_base_url", next);
    setEditingUrl(false);
    // Probe will re-fire via the baseUrl effect.
  };

  const handleStartOllama = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await ollamaStart(baseUrl);
      await runProbe();
    } catch (e) {
      // Typically "couldn't find the ollama binary" — which is exactly the
      // signal that distinguishes "installed but not running" from "not
      // installed", so it's worth showing verbatim.
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Status panel */}
      {probe.kind === "probing" ? (
        <StatusPanel tone="neutral" icon={<Loader2 className="h-4 w-4 animate-spin" />}>
          Looking for a running Ollama instance at{" "}
          <span className="font-mono">{baseUrl}</span>…
        </StatusPanel>
      ) : probe.kind === "down" ? (
        <StatusPanel
          tone="warn"
          icon={<AlertCircle className="h-4 w-4" />}
          title="Ollama isn't reachable"
        >
          <p>
            Nothing is answering at <span className="font-mono">{baseUrl}</span>.
            If Ollama is already installed, Loach can start it for you.
            Otherwise install it first — it starts on its own once installed.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={starting}
              onClick={() => void handleStartOllama()}
              className="gap-1.5"
            >
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {starting ? "Starting…" : "Start Ollama"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void openExternal("https://ollama.com/download")}
              className="gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Download Ollama
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditingUrl((v) => !v)}
            >
              Change URL
            </Button>
          </div>
          {startError && (
            <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-destructive">
              <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
              {startError}
            </p>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground/45">
            <RefreshCw className="h-3 w-3 animate-spin [animation-duration:3s]" />
            Rechecking automatically — this panel updates itself when Ollama
            comes up.
          </p>
        </StatusPanel>
      ) : probe.models.length > 0 ? (
        <StatusPanel
          tone="ok"
          icon={<Check className="h-4 w-4" />}
          title="Found a running Ollama instance"
        >
          {probe.models.length === 1
            ? "1 model installed and ready to use."
            : `${probe.models.length} models installed and ready to use.`}
        </StatusPanel>
      ) : (
        <StatusPanel
          tone="neutral"
          icon={<Server className="h-4 w-4" />}
          title="Ollama is running, no models yet"
        >
          Pick one below — Loach will pull it for you. You can continue setup
          while the download runs.
        </StatusPanel>
      )}

      {editingUrl && (
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <Label htmlFor="onboarding-ollama-url" className="text-[12px]">Ollama base URL</Label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="onboarding-ollama-url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="http://localhost:11434"
              className="h-9"
            />
            <Button size="sm" onClick={() => void handleUrlSave()}>
              Save
            </Button>
          </div>
        </div>
      )}

      {/* Models already installed — let the user choose which one this
          install defaults to instead of silently taking the first. */}
      {probe.kind === "up" && probe.models.length > 0 && (
        <DefaultModelPicker
          models={probe.models}
          value={pinnedModel}
          onSelect={(id) => void setProviderDefault("ollama", id)}
          hint="Used for new chats. Change it any time from the model dropdown."
        />
      )}

      {/* Catalog only when we know Ollama is up but empty (or after the
          user has clicked Recheck successfully). When models already
          exist we hide the catalog — the picker above is enough; if
          they want more they can pull from the Models page later. */}
      {probe.kind === "up" && probe.models.length === 0 && (
        <ModelCatalog host={host} onPulled={onProvisioned} />
      )}
    </div>
  );
}

function StatusPanel({
  tone,
  icon,
  title,
  children,
}: {
  tone: "ok" | "warn" | "neutral";
  icon: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  // The tone colour is inherited by the leading icon (the body below sets
  // its own `text-foreground/85`). Light/dark pair rather than the bare
  // bright tone: on the light theme these washes are near-white, where
  // emerald-300 / amber-300 land around 1.3:1.
  const palette =
    tone === "ok"
      ? "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-800 dark:text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-800 dark:text-amber-300"
        : "border-foreground/10 bg-foreground/[0.03] text-foreground/75";
  return (
    <div className={cn("rounded-xl border p-3.5 text-[12.5px] leading-relaxed", palette)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1 text-foreground/85">
          {title && <p className="mb-0.5 font-medium text-foreground">{title}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Provider selector shown once a path is open. Replaces the old
 * "Pick a different provider" back-chip, which could say only that *a*
 * choice had been made — never which one. The big choice cards unmount as
 * soon as a provider is picked, so this row is the only place the current
 * selection can be represented: it shows both options, marks the active
 * one visually and via `aria-pressed`, and switches in one click instead
 * of back-then-repick.
 *
 * Toggle buttons rather than `role="radio"` on purpose: a radiogroup owes
 * the user arrow-key roving focus, and two plain `aria-pressed` buttons
 * announce their state just as clearly without that keyboard debt.
 */
function ProviderSwitch({
  value,
  onChange,
}: {
  value: Exclude<Phase, "choose">;
  onChange: (p: Exclude<Phase, "choose">) => void;
}) {
  const options = [
    { id: "ollama" as const, label: "Ollama", icon: <HardDrive className="h-3.5 w-3.5" /> },
    { id: "openai" as const, label: "OpenAI API", icon: <Cloud className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="flex items-center gap-2">
      <span id="provider-switch-label" className="text-[11.5px] text-foreground/50">
        Provider
      </span>
      <div
        role="group"
        aria-labelledby="provider-switch-label"
        className="inline-flex gap-1 rounded-full border border-foreground/[0.08] bg-foreground/[0.03] p-0.5"
      >
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                active
                  ? "bg-foreground/[0.10] text-foreground"
                  : "text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85",
              )}
            >
              {o.icon}
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── default model picker ───────────────────────── */

/**
 * Shows — and lets the user change — which model this install will start new
 * chats with. Both provider paths used to pin `list[0]` and say nothing,
 * which on api.openai.com means the first reply can come from whatever
 * `/v1/models` happened to return first. The pick is now visible even when
 * the user accepts it unchanged.
 */
function DefaultModelPicker({
  models,
  value,
  onSelect,
  hint,
}: {
  models: ModelInfo[];
  value: string;
  onSelect: (id: string) => void;
  hint: string;
}) {
  const current = models.find((m) => m.id === value) ?? models[0];
  return (
    <div className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.015] p-3">
      <Label className="text-[12px]">Default model</Label>
      <div className="mt-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between gap-2 font-mono text-[12.5px]"
            >
              <span className="truncate">{current?.label ?? current?.id ?? "Select a model"}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          {/* z-60, not the primitive's default z-50: this menu portals to
              document.body, where it lands in the same stacking context as the
              onboarding overlay (z-55). At the default it opens *behind* the
              backdrop and reads as a dead button. 60 clears the overlay while
              staying under the TitleBar (z-70), so window controls keep
              working — the same band LockScreen uses. */}
          <DropdownMenuContent
            align="start"
            className="z-[60] max-h-72 w-72 overflow-y-auto"
          >
            {models.map((m) => (
              <DropdownMenuItem
                key={m.id}
                onSelect={() => onSelect(m.id)}
                className="gap-2 font-mono text-[12.5px]"
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    m.id === current?.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{m.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-1.5 text-[11px] text-foreground/50">{hint}</p>
    </div>
  );
}

/* ───────────────────────── Ollama catalog ───────────────────────── */

/** Small coloured pill describing how a variant sits on this machine. */
function FitBadge({ fit, recommended }: { fit: FitVerdict | null; recommended: boolean }) {
  if (recommended) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
        <Sparkles className="h-2.5 w-2.5" />
        Best fit
      </span>
    );
  }
  if (!fit) return null;
  if (fit.insufficientDisk) {
    return (
      <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
        Not enough disk
      </span>
    );
  }
  if (fit.tier === "heavy") {
    return (
      <span className="shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-foreground/50">
        Needs ~{formatGb(fit.requiredGb)} RAM
      </span>
    );
  }
  if (fit.tier === "tight") {
    return (
      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
        Heavy
      </span>
    );
  }
  return null;
}

function ModelCatalog({
  host,
  onPulled,
}: {
  host: HostCapacity | null;
  onPulled: () => void;
}) {
  const pullModel = useModelsStore((s) => s.pullModel);
  const setProviderDefault = useSettingsStore((s) => s.setProviderDefault);
  const runs = useModelsStore((s) => s.runs);

  // Track which family rows are expanded. Default: first family open.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    [OLLAMA_CATALOG[0]?.family ?? ""]: true,
  });
  const toggle = (k: string) =>
    setExpanded((e) => ({ ...e, [k]: !e[k] }));

  // Custom tag input
  const [customTag, setCustomTag] = useState("");
  // The custom-tag card sits below the catalog and can end up under the
  // fold on short windows; the header link scrolls it into view so users
  // who arrived with a specific tag in mind can find it without hunting.
  const customTagRef = useRef<HTMLInputElement>(null);
  const jumpToCustomTag = () => {
    customTagRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
    customTagRef.current?.focus({ preventScroll: true });
  };

  // Track tags we've kicked off so we can show their progress chip even
  // after the run cleans up. Map: tag -> stream id.
  const [pulledTags, setPulledTags] = useState<Record<string, string>>({});

  const recommended = useMemo(
    () => (host ? recommendVariant(ALL_VARIANTS, host) : null),
    [host],
  );

  const startPull = async (tag: string) => {
    if (!tag.trim()) return;
    // Don't stack a second pull of the same tag on top of a live one — the
    // Retry button is reachable while the previous attempt is still running.
    const live = Object.values(useModelsStore.getState().runs).some(
      (r) => r.kind === "pull" && r.target === tag && r.finished === null,
    );
    if (live) return;
    // Pin as default and unblock Continue immediately — the pull
    // streams in the background, and the user can keep onboarding
    // while it finishes. Progress remains visible on the Models tab
    // via the existing run-tracker; in-card progress here updates
    // live too.
    await setProviderDefault("ollama", tag);
    onPulled();
    void pullModel(tag);
    // The store generates a stream id internally, so we can't pre-bind it.
    // Instead, after a tick, find this tag's run and remember its id for
    // progress display.
    //
    // Crucially this looks for an UNFINISHED run. Failed runs are never
    // dismissed during onboarding, so plain `find` returned the first
    // (already errored) one — Retry re-bound the row to the dead run and
    // appeared to do nothing while the new pull streamed invisibly.
    window.setTimeout(() => {
      const all = useModelsStore.getState().runs;
      const match = Object.entries(all).find(
        ([, r]) => r.kind === "pull" && r.target === tag && r.finished === null,
      );
      if (match) setPulledTags((t) => ({ ...t, [tag]: match[0] }));
    }, 50);
  };

  const inFlight = useMemo(() => {
    const out: Record<string, AdminProgress> = {};
    for (const [tag, sid] of Object.entries(pulledTags)) {
      const r = runs[sid];
      if (r) out[tag] = r;
    }
    return out;
  }, [runs, pulledTags]);

  return (
    <div className="space-y-3">
      {recommended && host && (
        <RecommendationCard
          variant={recommended}
          host={host}
          run={inFlight[recommended.tag]}
          onPull={() => void startPull(recommended.tag)}
        />
      )}

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-medium">
            {recommended ? "All models" : "Recommended models"}
          </h3>
          <button
            type="button"
            onClick={jumpToCustomTag}
            className="shrink-0 text-[11.5px] text-foreground/55 underline-offset-2 hover:text-foreground hover:underline"
          >
            Have a specific tag in mind?
          </button>
        </div>
        <p className="mt-0.5 text-[11.5px] text-foreground/50">
          Sizes are approximate disk footprint after the pull finishes.
          MoE = mixture of experts (only a fraction of weights run per
          token, so they're faster than the headline parameter count).
        </p>
      </div>

      <ul className="overflow-hidden rounded-xl border border-foreground/[0.08] bg-foreground/[0.015]">
        {OLLAMA_CATALOG.map((fam, idx) => {
          const open = expanded[fam.family];
          return (
            <li
              key={fam.family}
              className={cn(
                "transition-colors",
                idx > 0 && "border-t border-foreground/[0.06]",
              )}
            >
              {/* Family row is a div (not a button) because it contains an
                  inner "ollama.com" button — nesting <button> inside <button>
                  is invalid HTML and trips React's validateDOMNesting. Manual
                  role + key handler keeps the row keyboard-operable. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(fam.family)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(fam.family);
                  }
                }}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-foreground/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-foreground/45 transition-transform",
                      open ? "rotate-0" : "-rotate-90",
                    )}
                  />
                  <span className="text-[13px] font-medium">{fam.family}</span>
                  <span className="text-[11px] text-foreground/45">
                    {fam.variants.length}{" "}
                    {fam.variants.length === 1 ? "variant" : "variants"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openExternal(fam.url);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  ollama.com
                </button>
              </div>
              {open && (
                <div className="border-t border-foreground/[0.05] bg-background/40">
                  {fam.variants.map((v) => {
                    const run = inFlight[v.tag];
                    const fit = host ? classifyFit(v.sizeGb, host) : null;
                    return (
                      <VariantRow
                        key={v.tag}
                        label={v.label}
                        sizeGb={v.sizeGb}
                        tag={v.tag}
                        run={run}
                        fit={fit}
                        recommended={recommended?.tag === v.tag}
                        onPull={() => void startPull(v.tag)}
                      />
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.015] p-3">
        <Label htmlFor="onboarding-custom-tag" className="text-[12px]">Pull a custom tag</Label>
        <p className="mt-0.5 text-[11px] text-foreground/50">
          Any tag from{" "}
          <button
            type="button"
            onClick={() => void openExternal("https://ollama.com/library")}
            className="text-foreground/70 underline-offset-2 hover:underline"
          >
            ollama.com/library
          </button>
          . Examples: <span className="font-mono">llama3.1:8b</span>,{" "}
          <span className="font-mono">deepseek-r1:14b</span>.
        </p>
        <div className="mt-2 flex gap-2">
          <Input
            id="onboarding-custom-tag"
            ref={customTagRef}
            value={customTag}
            onChange={(e) => setCustomTag(e.target.value)}
            placeholder="model:tag"
            className="h-9 font-mono text-[12.5px]"
          />
          <Button
            size="sm"
            disabled={!customTag.trim()}
            onClick={() => void startPull(customTag.trim())}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Pull
          </Button>
        </div>
        {customTag && inFlight[customTag.trim()] && (
          <div className="mt-2">
            <ProgressBar run={inFlight[customTag.trim()]} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The one suggestion the step leads with. A newcomer's real question is "what
 * should I pick for this machine?", which a list of seventeen tags and their
 * disk sizes doesn't answer — so we answer it directly and keep the full
 * catalog underneath as the escape hatch.
 */
function RecommendationCard({
  variant,
  host,
  run,
  onPull,
}: {
  variant: CatalogVariant;
  host: HostCapacity;
  run: AdminProgress | undefined;
  onPull: () => void;
}) {
  const fit = classifyFit(variant.sizeGb, host);
  const ramGb = bytesToGb(host.totalRamBytes);
  const diskGb = host.freeDiskBytes === null ? null : bytesToGb(host.freeDiskBytes);
  const downloading = run && !run.finished;
  const done = run?.finished === "ok";

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.05] p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-primary">
        <Sparkles className="h-3 w-3" />
        Recommended for this machine
      </div>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[13.5px] font-medium">{variant.tag}</p>
          <p className="mt-0.5 text-[11.5px] text-foreground/60">
            ~{formatGb(variant.sizeGb)} download ·{" "}
            {fit.tier === "comfortable"
              ? "runs comfortably alongside your other apps"
              : fit.tier === "tight"
                ? "the smallest we list — expect it to be tight here"
                : "larger than this machine's RAM, but the smallest we list"}
          </p>
        </div>
        {done ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-800 dark:text-emerald-300">
            <Check className="h-3 w-3" />
            Ready
          </span>
        ) : downloading ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground/55">
            <Loader2 className="h-3 w-3 animate-spin" />
            {fmtPct(run!)}
          </span>
        ) : (
          <Button
            size="sm"
            disabled={fit.insufficientDisk}
            onClick={onPull}
            className="shrink-0 gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Pull this one
          </Button>
        )}
      </div>
      {run && (
        <div className="mt-2">
          <ProgressBar run={run} />
        </div>
      )}
      <p className="mt-2 text-[11px] text-foreground/45">
        Based on {formatGb(ramGb)} RAM
        {diskGb !== null && ` · ${formatGb(diskGb)} free on disk`}
        {fit.insufficientDisk && " — not enough free space for this download"}
      </p>
    </div>
  );
}

function VariantRow({
  label,
  sizeGb,
  tag,
  run,
  fit,
  recommended,
  onPull,
}: {
  label: string;
  sizeGb: number;
  tag: string;
  run: AdminProgress | undefined;
  fit: FitVerdict | null;
  recommended: boolean;
  onPull: () => void;
}) {
  const downloading = run && !run.finished;
  const done = run?.finished === "ok";
  const failed = run?.finished === "error";

  return (
    <div className="flex items-center gap-3 px-3.5 py-2 text-[12.5px]">
      <CircleDot className="h-3 w-3 text-foreground/30" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          <span className="text-[11px] text-foreground/45">~{formatGb(sizeGb)}</span>
          <FitBadge fit={fit} recommended={recommended} />
        </div>
        <p className="font-mono text-[11px] text-foreground/40">{tag}</p>
        {run && (
          <div className="mt-1.5">
            <ProgressBar run={run} />
          </div>
        )}
      </div>
      {done ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
          <Check className="h-3 w-3" />
          Ready
        </span>
      ) : failed ? (
        <Button size="sm" variant="outline" onClick={onPull} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      ) : downloading ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-foreground/55">
          <Loader2 className="h-3 w-3 animate-spin" />
          {fmtPct(run!)}
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={fit?.insufficientDisk}
          title={fit?.insufficientDisk ? "Not enough free disk space for this download" : undefined}
          onClick={onPull}
          className="gap-1.5"
        >
          <Download className="h-3.5 w-3.5" />
          Pull
        </Button>
      )}
    </div>
  );
}

function ProgressBar({ run }: { run: AdminProgress }) {
  if (run.finished === "error") {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-destructive">
        <XCircle className="h-3 w-3" />
        {run.error ?? "Pull failed"}
      </p>
    );
  }
  const pct =
    run.total > 0
      ? Math.min(100, Math.round((run.completed / run.total) * 100))
      : null;
  return (
    <div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
        <div
          className={cn(
            "h-full bg-primary transition-all",
            pct === null && "animate-pulse",
          )}
          style={{ width: pct === null ? "30%" : `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[10.5px] text-foreground/45">
        {run.status}
        {pct !== null && ` · ${pct}%`}
      </p>
    </div>
  );
}

function fmtPct(run: AdminProgress) {
  if (run.total <= 0) return "starting…";
  return `${Math.min(100, Math.round((run.completed / run.total) * 100))}%`;
}

/* ───────────────────────── OpenAI path ───────────────────────── */

function OpenAIPath({ onProvisioned }: { onProvisioned: () => void }) {
  const baseUrl = useSettingsStore((s) => s.openai_base_url);
  const keySet = useSettingsStore((s) => s.openai_key_set);
  const pinnedModel = useSettingsStore((s) => s.default_model);
  const update = useSettingsStore((s) => s.update);
  const setOpenAIKey = useSettingsStore((s) => s.setOpenAIKey);
  const clearOpenAIKey = useSettingsStore((s) => s.clearOpenAIKey);
  const setProviderDefault = useSettingsStore((s) => s.setProviderDefault);
  const refreshModels = useModelsStore((s) => s.refresh);

  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(keySet);
  /** Models the verified endpoint returned, ranked so a chat model leads.
   *  Feeds the default-model picker below. */
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);

  // If a verified key is already stored (the user set it, advanced, then
  // navigated back), the parent's `provisioned` flag has reset but there's
  // nothing left to do — mark provisioned so Continue re-enables without
  // forcing a full re-type. Snapshot the flag at MOUNT rather than
  // subscribing to it: `setOpenAIKey` flips `openai_key_set` true before
  // the probe validates the key, so a live subscription would fire
  // mid-save and enable Continue — and a failed probe only rolls the key
  // back, never the parent's `provisioned` flag. At mount no save can be
  // in flight, so a stored key here really is a verified one.
  const keySetAtMount = useRef(useSettingsStore.getState().openai_key_set);
  useEffect(() => {
    if (!keySetAtMount.current) return;
    onProvisioned();
    // Also re-load the catalog. `catalog` is otherwise only filled by
    // `handleSave`, so a user returning to this step with a key already
    // verified got no default-model picker at all — nothing to change the
    // pick with, and no indication of what the pick even was. Mount-only by
    // construction (the ref is a mount snapshot), so reading `baseUrl` from
    // the closure is deliberate rather than a stale dep.
    void openaiListModels(baseUrl)
      .then((list) => setCatalog(rankChatModels(list)))
      .catch(() => {
        /* Key may have been revoked since — the form below still works. */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onProvisioned]);

  const handleSave = async () => {
    setError(null);
    if (!key.trim()) {
      setError("Enter an API key.");
      return;
    }
    setBusy(true);
    try {
      // Persist URL changes first so the model-list call uses the right base.
      if (urlDraft.trim() && urlDraft.trim() !== baseUrl) {
        await update("openai_base_url", urlDraft.trim());
      }
      // The probe reads the key from the keyring, so it must be stored first.
      // If the probe then fails, roll the key back below — leaving a known-bad
      // key stored would flip `keySet` true and auto-provision it on re-entry.
      await setOpenAIKey(key.trim());
      try {
        // Probe — a key that isn't valid will surface here as a 401.
        const list = await openaiListModels(urlDraft.trim() || baseUrl);
        const ranked = rankChatModels(list);
        setCatalog(ranked);
        if (ranked.length > 0) {
          // Pin the best chat candidate rather than whatever `/v1/models`
          // listed first — on api.openai.com that's frequently an embedding
          // or audio model. The picker below shows the result either way.
          await setProviderDefault("openai", ranked[0].id);
        }
        await refreshModels();
      } catch (probeErr) {
        await clearOpenAIKey().catch(() => {});
        throw probeErr;
      }
      setVerified(true);
      setKey("");
      onProvisioned();
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}. Double-check the key and base URL.`
          : "Couldn't verify the API key.",
      );
      setVerified(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.015] p-4 space-y-4">
        <div>
          <Label htmlFor="onboarding-openai-url" className="text-[12px]">Base URL</Label>
          <Input
            id="onboarding-openai-url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="mt-1.5 h-9"
          />
          <p className="mt-1 text-[11px] text-foreground/50">
            Override to use vLLM, LM Studio, LiteLLM, or any
            OpenAI-compatible proxy.
          </p>
        </div>

        <div>
          <Label htmlFor="onboarding-openai-key" className="text-[12px]">API key</Label>
          <div className="mt-1.5 flex gap-2">
            <div className="relative flex-1">
              <Input
                id="onboarding-openai-key"
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={keySet ? "•••••••• (stored)" : "sk-…"}
                className="h-9 pr-9 font-mono text-[12.5px]"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <Button
              size="sm"
              disabled={busy || !key.trim()}
              onClick={() => void handleSave()}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                // Arrow (not Check) before the click — Check would read as
                // "already verified". The success state below the input
                // owns the check-mark once the probe returns.
                <ArrowRight className="h-3.5 w-3.5" />
              )}
              {busy ? "Verifying" : "Verify & save"}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-foreground/50">
            Stored in your OS credential manager. Never written to disk in
            plain text.{" "}
            <button
              type="button"
              onClick={() =>
                void openExternal("https://platform.openai.com/api-keys")
              }
              className="text-foreground/65 underline-offset-2 hover:text-foreground hover:underline"
            >
              Create an API key →
            </button>
          </p>
        </div>

        {error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        {verified && !error && (
          <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-[12px] text-emerald-800 dark:text-emerald-300">
            <Check className="h-3.5 w-3.5" />
            Key verified — you're ready to chat.
          </p>
        )}
      </div>

      {catalog.length > 0 && (
        <DefaultModelPicker
          models={catalog}
          value={pinnedModel}
          onSelect={(id) => void setProviderDefault("openai", id)}
          hint={`${catalog.length} models available. Used for new chats — change it any time from the model dropdown.`}
        />
      )}
    </div>
  );
}
