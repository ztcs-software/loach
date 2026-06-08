import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelsStore, type AdminProgress } from "@/stores/modelsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import {
  isTauri,
  ollamaListModels,
  openaiListModels,
} from "@/lib/tauri";
import type { ProviderId } from "@/types";
import { cn } from "@/lib/utils";
import { StepShell } from "./StepShell";

/**
 * Provider configuration — the only step the user can't skip past
 * without consequence. Two flows live here side by side:
 *
 *   - Ollama: probe `/api/tags`. If the daemon already lists at least
 *     one model, we silently auto-pick the first one and zoom past to
 *     the next step (after showing a quick "Found Ollama" confirmation
 *     the user can dismiss). If no models are present we show the
 *     recommended catalog plus a custom-tag input. Pulls run inline
 *     and the user can keep onboarding while a download finishes —
 *     the existing run-tracker chip in the sidebar takes over once
 *     they reach the chat.
 *
 *   - OpenAI API: base URL + key. Saving runs `openai_list_models` as
 *     a connectivity probe; a 401 / network error blocks Continue and
 *     surfaces inline. We don't try to guess a default model here —
 *     the chat empty-state's model picker handles that.
 *
 * The X behaviour (`onCloseRequest`) bubbles up to the controller so
 * it can show the "Skip setup?" confirmation; the local state stays
 * intact in case the user cancels the dismiss.
 */

type Phase = "choose" | "ollama" | "openai";

// Recommended Ollama catalog. Sizes are rough disk-footprint estimates so
// users can budget; exact bytes come back during the pull stream.
const OLLAMA_CATALOG: {
  family: string;
  url: string;
  variants: { tag: string; label: string; size: string }[];
}[] = [
  {
    family: "Gemma 4",
    url: "https://ollama.com/library/gemma4",
    variants: [
      { tag: "gemma4:e2b", label: "E2B", size: "~7.2 GB" },
      { tag: "gemma4:e4b", label: "E4B", size: "~9.6 GB" },
      { tag: "gemma4:12b", label: "12B", size: "~7.6 GB" },
      { tag: "gemma4:26b", label: "26B (MoE)", size: "~18 GB" },
      { tag: "gemma4:31b", label: "31B", size: "~20 GB" },
    ],
  },
  {
    family: "Qwen 3.5",
    url: "https://ollama.com/library/qwen3.5",
    variants: [
      { tag: "qwen3.5:0.8b", label: "0.8B", size: "~1 GB" },
      { tag: "qwen3.5:2b", label: "2B", size: "~2.7 GB" },
      { tag: "qwen3.5:4b", label: "4B", size: "~3.4 GB" },
      { tag: "qwen3.5:9b", label: "9B", size: "~6.6 GB" },
      { tag: "qwen3.5:27b", label: "27B", size: "~17 GB" },
      { tag: "qwen3.5:35b", label: "35B (MoE)", size: "~24 GB" },
      { tag: "qwen3.5:122b", label: "122B (MoE)", size: "~81 GB" },
    ],
  },
  {
    family: "Qwen 3.6",
    url: "https://ollama.com/library/qwen3.6",
    variants: [
      { tag: "qwen3.6:27b", label: "27B", size: "~17 GB" },
      { tag: "qwen3.6:35b", label: "35B (MoE)", size: "~24 GB" },
    ],
  },
  {
    family: "Ministral 3",
    url: "https://ollama.com/library/ministral-3",
    variants: [
      { tag: "ministral-3:3b", label: "3B", size: "~3 GB" },
      { tag: "ministral-3:8b", label: "8B", size: "~6 GB" },
      { tag: "ministral-3:14b", label: "14B", size: "~9.1 GB" },
    ],
  },
];

async function openExternal(url: string) {
  if (isTauri) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
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
      ) : phase === "ollama" ? (
        <OllamaPath
          onBack={() => {
            setProvisioned(false);
            setPhase("choose");
          }}
          onProvisioned={() => setProvisioned(true)}
        />
      ) : (
        <OpenAIPath
          onBack={() => {
            setProvisioned(false);
            setPhase("choose");
          }}
          onProvisioned={() => setProvisioned(true)}
        />
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
  | { kind: "up"; modelCount: number };

function OllamaPath({
  onBack,
  onProvisioned,
}: {
  onBack: () => void;
  onProvisioned: () => void;
}) {
  const baseUrl = useSettingsStore((s) => s.ollama_base_url);
  const update = useSettingsStore((s) => s.update);
  const setProviderDefault = useSettingsStore((s) => s.setProviderDefault);
  const refreshModels = useModelsStore((s) => s.refresh);

  const [probe, setProbe] = useState<OllamaProbe>({ kind: "probing" });
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState(baseUrl);

  const runProbe = async () => {
    setProbe({ kind: "probing" });
    try {
      const list = await ollamaListModels(baseUrl);
      setProbe({ kind: "up", modelCount: list.length });
      if (list.length > 0) {
        // Pre-existing models — auto-pin the first one as the default
        // and let the user advance immediately.
        await setProviderDefault("ollama", list[0].id);
        await refreshModels();
        onProvisioned();
      }
    } catch (e) {
      setProbe({
        kind: "down",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    void runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  const handleUrlSave = async () => {
    const next = urlDraft.trim();
    if (!next) return;
    await update("ollama_base_url", next);
    setEditingUrl(false);
    // Probe will re-fire via the baseUrl effect.
  };

  return (
    <div className="space-y-4">
      <BackChip onBack={onBack} label="Pick a different provider" />

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
            Couldn't connect to <span className="font-mono">{baseUrl}</span>.
            Install Ollama and run <span className="font-mono">ollama serve</span>,
            then retry.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void runProbe()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Recheck
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
        </StatusPanel>
      ) : probe.modelCount > 0 ? (
        <StatusPanel
          tone="ok"
          icon={<Check className="h-4 w-4" />}
          title="Found a running Ollama instance"
        >
          {probe.modelCount === 1
            ? "1 model installed and ready to use."
            : `${probe.modelCount} models installed and ready to use.`}{" "}
          You're set — hit Continue.
        </StatusPanel>
      ) : (
        <StatusPanel
          tone="neutral"
          icon={<Server className="h-4 w-4" />}
          title="Ollama is running, no models yet"
        >
          Pick one from the list below — Loach will pull it for you. You can
          continue while the download runs.
        </StatusPanel>
      )}

      {editingUrl && (
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <Label className="text-[12px]">Ollama base URL</Label>
          <div className="mt-1.5 flex gap-2">
            <Input
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

      {/* Catalog only when we know Ollama is up but empty (or after the
          user has clicked Recheck successfully). When models already
          exist we hide the catalog — the auto-advance is enough; if
          they want more they can pull from the Models page later. */}
      {probe.kind === "up" && probe.modelCount === 0 && (
        <ModelCatalog onPulled={onProvisioned} />
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
  const palette =
    tone === "ok"
      ? "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-300"
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

function BackChip({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex items-center gap-1 text-[11.5px] text-foreground/55 hover:text-foreground transition-colors"
    >
      <ChevronRight className="h-3.5 w-3.5 rotate-180" />
      {label}
    </button>
  );
}

/* ───────────────────────── Ollama catalog ───────────────────────── */

function ModelCatalog({ onPulled }: { onPulled: () => void }) {
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

  // Track tags we've kicked off so we can show their progress chip even
  // after the run cleans up. Map: tag -> stream id.
  const [pulledTags, setPulledTags] = useState<Record<string, string>>({});

  const startPull = async (tag: string) => {
    if (!tag.trim()) return;
    // Pin as default and unblock Continue immediately — the pull
    // streams in the background, and the user can keep onboarding
    // while it finishes. Progress remains visible on the Models tab
    // via the existing run-tracker; in-card progress here updates
    // live too.
    await setProviderDefault("ollama", tag);
    onPulled();
    void pullModel(tag);
    // The store generates a stream id internally, so we can't pre-bind
    // it. Instead, after a tick, find the most recent run with this tag
    // and remember its id for progress display.
    window.setTimeout(() => {
      const all = useModelsStore.getState().runs;
      const match = Object.entries(all).find(
        ([, r]) => r.kind === "pull" && r.target === tag,
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
      <div>
        <h3 className="text-[13px] font-medium">Recommended models</h3>
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
                    return (
                      <VariantRow
                        key={v.tag}
                        label={v.label}
                        size={v.size}
                        tag={v.tag}
                        run={run}
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
        <Label className="text-[12px]">Pull a custom tag</Label>
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

function VariantRow({
  label,
  size,
  tag,
  run,
  onPull,
}: {
  label: string;
  size: string;
  tag: string;
  run: AdminProgress | undefined;
  onPull: () => void;
}) {
  const downloading = run && !run.finished;
  const done = run?.finished === "ok";
  const failed = run?.finished === "error";

  return (
    <div className="flex items-center gap-3 px-3.5 py-2 text-[12.5px]">
      <CircleDot className="h-3 w-3 text-foreground/30" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          <span className="text-[11px] text-foreground/45">{size}</span>
        </div>
        <p className="font-mono text-[11px] text-foreground/40">{tag}</p>
        {run && (
          <div className="mt-1.5">
            <ProgressBar run={run} />
          </div>
        )}
      </div>
      {done ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
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
        <Button size="sm" variant="outline" onClick={onPull} className="gap-1.5">
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

function OpenAIPath({
  onBack,
  onProvisioned,
}: {
  onBack: () => void;
  onProvisioned: () => void;
}) {
  const baseUrl = useSettingsStore((s) => s.openai_base_url);
  const keySet = useSettingsStore((s) => s.openai_key_set);
  const update = useSettingsStore((s) => s.update);
  const setOpenAIKey = useSettingsStore((s) => s.setOpenAIKey);
  const setProviderDefault = useSettingsStore((s) => s.setProviderDefault);
  const refreshModels = useModelsStore((s) => s.refresh);

  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(keySet);

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
      await setOpenAIKey(key.trim());
      // Probe — a key that isn't valid will surface here as a 401.
      const list = await openaiListModels(urlDraft.trim() || baseUrl);
      if (list.length > 0) {
        // Pin a sensible default (first model returned). The user can
        // change later from Settings.
        await setProviderDefault("openai", list[0].id);
      }
      await refreshModels();
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
      <BackChip onBack={onBack} label="Pick a different provider" />

      <div className="rounded-xl border border-foreground/[0.08] bg-foreground/[0.015] p-4 space-y-4">
        <div>
          <Label className="text-[12px]">Base URL</Label>
          <Input
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
          <Label className="text-[12px]">API key</Label>
          <div className="mt-1.5 flex gap-2">
            <div className="relative flex-1">
              <Input
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
          <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-[12px] text-emerald-300">
            <Check className="h-3.5 w-3.5" />
            Key verified — you're ready to chat.
          </p>
        )}
      </div>
    </div>
  );
}
