import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Brain,
  Cpu,
  Eye,
  EyeOff,
  HardDrive,
  Info,
  Loader2,
  Play,
  Save,
  Sliders,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { buildModelfile, parseParamsBlock } from "@/lib/modelfile";
import { formatBytes } from "@/lib/utils";
import type {
  ModelInfo,
  ModelfileForm,
  ModelfileParams,
  OllamaShowResponse,
} from "@/types";

/**
 * Main-area editor for a single Ollama model. Lets the user:
 *   - Inspect the model's Modelfile / system prompt / template / parameters
 *   - Tweak any of those knobs and save the result as a *new* derived model
 *     via `POST /api/create` (`Save as…`). We never overwrite the base
 *     model — that matches Ollama's own Modelfile workflow and means the
 *     "FROM" line is always a valid base the user can fall back to.
 *   - Delete the current model
 *   - Launch a fresh chat pre-selected to this model
 *
 * The form is prefilled from `/api/show`, and fields left blank (null-ish)
 * are omitted from the emitted Modelfile so the derived model inherits
 * those defaults from its base.
 */
export function ModelsView() {
  const { confirm } = useConfirm();
  const viewingModel = useModelsStore((s) => s.viewingModel);
  const setViewingModel = useModelsStore((s) => s.setViewingModel);
  const showModel = useModelsStore((s) => s.showModel);
  const deleteModel = useModelsStore((s) => s.deleteModel);
  const createModel = useModelsStore((s) => s.createModel);
  const models = useModelsStore((s) => s.models);

  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  // Per-model thinking preference. Stored in modelsStore so the chat-send
  // path (`readSessionParams`) and the per-chat ParameterPanel both pick
  // it up automatically — this view just exposes the lever.
  const thinkPref = useModelsStore((s) =>
    viewingModel ? s.modelThinkPrefs[viewingModel] : undefined,
  );
  const setThinkPref = useModelsStore((s) => s.setModelThinkPref);

  const [details, setDetails] = useState<OllamaShowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<ModelfileForm>(() => emptyForm(""));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const baseInfo = useMemo<ModelInfo | undefined>(
    () => models.find((m) => m.id === viewingModel && m.provider === "ollama"),
    [models, viewingModel],
  );

  // Pull fresh details on mount / model change. Prefill the form with the
  // existing values so hitting Save without any edits rebuilds the same
  // model under a new tag (the safe identity transform).
  useEffect(() => {
    if (!viewingModel) return;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setDetails(null);
    void showModel(viewingModel)
      .then((d) => {
        setDetails(d);
        setForm(formFromDetails(viewingModel, d));
      })
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [viewingModel, showModel]);

  if (!viewingModel) return null;

  const handleBack = () => {
    setViewingModel(null);
    setSidebarTab("models");
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Delete “${viewingModel}”?`,
      body: "This removes the model files from disk and cannot be undone.",
      confirmLabel: "Delete model",
      destructive: true,
    });
    if (!ok) return;
    await deleteModel(viewingModel);
  };

  const handleSave = async () => {
    setSaveError(null);
    let modelfile: string;
    try {
      modelfile = buildModelfile(form);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return;
    }
    const targetName = form.name.trim();
    if (!targetName) {
      setSaveError("Give the new model a tag, e.g. `my-llama:v1`.");
      return;
    }
    setSaving(true);
    try {
      const run = await createModel(targetName, modelfile);
      if (run?.finished === "ok") {
        // Land the user on the freshly-created model so they can immediately
        // iterate on it or try it in a new chat.
        setViewingModel(targetName);
      } else if (run?.finished === "error") {
        // The create reached a terminal error — surface the real reason
        // instead of navigating to a model that was never created.
        setSaveError(run.error ?? "Couldn't create the model.");
      }
      // `cancelled` → the user aborted; stay on the form with no error.
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleRunInChat = async () => {
    setViewingSpace(null);
    setViewingModel(null);
    await newSession({
      spaceId: null,
      provider: "ollama",
      model: viewingModel,
    });
    setSidebarTab("chats");
  };

  const previewText = useMemo(() => {
    try {
      return buildModelfile(form);
    } catch (e) {
      return `# Modelfile preview unavailable\n# ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  }, [form]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-4xl px-8 py-6">
          <button
            onClick={handleBack}
            className="mb-6 flex items-center gap-1.5 text-sm text-foreground/50 transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All models
          </button>

          {/* Header */}
          <div className="mb-6 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 truncate text-3xl font-semibold tracking-tight">
                <Cpu className="h-6 w-6 text-foreground/60" />
                {viewingModel}
              </h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground/50">
                {baseInfo?.family && <span>Family: {baseInfo.family}</span>}
                {baseInfo?.size && (
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="h-3 w-3" />
                    {formatBytes(baseInfo.size)}
                  </span>
                )}
                {detailSummary(details)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleRunInChat()}
                className="gap-1.5"
              >
                <Play className="h-3.5 w-3.5" />
                New chat
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDelete()}
                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>

          {loading && (
            <div className="flex items-center gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.03] px-4 py-6 text-sm text-foreground/50">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading model details…
            </div>
          )}

          {loadError && (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">
              {loadError}
            </div>
          )}

          {!loading && !loadError && (
            <div className="space-y-8">
              {/* Save-as card */}
              <section className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground/85">
                  <Save className="h-4 w-4 text-foreground/60" />
                  Save as new model
                </div>
                <p className="mb-3 text-xs text-foreground/55">
                  Customizations are stored as a{" "}
                  <span className="font-mono">derived model</span>. The base
                  model ({form.from}) is untouched — pick a new tag below and
                  Loach will call{" "}
                  <span className="font-mono">POST /api/create</span> for you.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>New model tag</Label>
                    <Input
                      className="mt-1.5"
                      value={form.name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, name: e.target.value }))
                      }
                      placeholder="my-llama:v1"
                    />
                  </div>
                  <div>
                    <Label>Base model (FROM)</Label>
                    <Input
                      className="mt-1.5"
                      value={form.from}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, from: e.target.value }))
                      }
                      placeholder="llama3.1:8b"
                    />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void handleSave()}
                    disabled={saving || !form.name.trim() || !form.from.trim()}
                    className="gap-1.5"
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPreview((v) => !v)}
                    className="gap-1.5 text-foreground/60"
                  >
                    {showPreview ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    {showPreview ? "Hide" : "Preview"} Modelfile
                  </Button>
                  {saveError && (
                    <span className="text-xs text-destructive">{saveError}</span>
                  )}
                </div>
                {showPreview && (
                  <pre className="mt-4 max-h-80 overflow-auto rounded-xl border border-foreground/10 bg-foreground/[0.04] p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
                    {previewText}
                  </pre>
                )}
              </section>

              {/* System prompt */}
              <section>
                <Label className="flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5 text-foreground/60" />
                  System prompt
                </Label>
                <Textarea
                  className="mt-1.5 min-h-32 resize-y font-mono text-xs"
                  value={form.system}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, system: e.target.value }))
                  }
                  placeholder="You are a helpful assistant…"
                />
                <p className="mt-1.5 text-[11px] text-foreground/50">
                  Baked into the model via the{" "}
                  <span className="font-mono">SYSTEM</span> directive. Per-chat
                  overrides still win at runtime.
                </p>
              </section>

              {/* Template */}
              <section>
                <Label>Prompt template</Label>
                <Textarea
                  className="mt-1.5 min-h-28 resize-y font-mono text-xs"
                  value={form.template}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, template: e.target.value }))
                  }
                  placeholder="{{ if .System }}<|system|>{{ .System }}<|end|>{{ end }}…"
                />
                <p className="mt-1.5 text-[11px] text-foreground/50">
                  Go-template syntax. Leave blank to inherit the base model's
                  template.
                </p>
              </section>

              <Separator />

              {/* Thinking — request-time toggle, not a Modelfile thing.
                  Sits above Parameters because it's a coarser switch
                  (whether to reason at all) than the fine-grained sliders
                  below. The toggle is disabled when the model's
                  `/api/show` capabilities don't list "thinking", because
                  flipping it would just be ignored by Ollama at chat time. */}
              <section>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/85">
                  <Brain className="h-4 w-4 text-foreground/60" />
                  Thinking
                </div>
                <ThinkingSection
                  capabilities={details?.capabilities ?? null}
                  pref={thinkPref}
                  onChange={(next) => {
                    if (!viewingModel) return;
                    setThinkPref(viewingModel, next);
                  }}
                />
              </section>

              <Separator />

              {/* Parameters */}
              <section>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/85">
                  <Sliders className="h-4 w-4 text-foreground/60" />
                  Parameters
                </div>
                <p className="mb-4 text-xs text-foreground/55">
                  Each field maps to a{" "}
                  <span className="font-mono">PARAMETER</span> line in the
                  Modelfile. Leave blank to inherit the base model's value.
                </p>
                <ParamsGrid
                  params={form.params}
                  onChange={(patch) =>
                    setForm((f) => ({
                      ...f,
                      params: { ...f.params, ...patch },
                    }))
                  }
                />

                {/* Stop sequences */}
                <div className="mt-5">
                  <Label>Stop sequences</Label>
                  <StopEditor
                    values={form.params.stop ?? []}
                    onChange={(stop) =>
                      setForm((f) => ({ ...f, params: { ...f.params, stop } }))
                    }
                  />
                </div>
              </section>

              <Separator />

              {/* Raw Modelfile (read-only peek at what's live on the daemon) */}
              <section>
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-foreground/45 transition-colors hover:text-foreground/70"
                >
                  {showRaw ? (
                    <EyeOff className="h-3 w-3" />
                  ) : (
                    <Eye className="h-3 w-3" />
                  )}
                  {showRaw ? "Hide" : "Show"} live Modelfile
                </button>
                {showRaw && (
                  <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-foreground/10 bg-foreground/[0.04] p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
                    {details?.modelfile?.trim() ||
                      "# (daemon returned no Modelfile for this model)"}
                  </pre>
                )}
              </section>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function emptyForm(name: string): ModelfileForm {
  return {
    name,
    from: "",
    system: "",
    template: "",
    params: { stop: [] },
  };
}

/** Build the editor state from a `/api/show` response. We:
 *   - Suggest a new tag based on the source name (`source-custom`) so the
 *     user can save without thinking.
 *   - Prefill `FROM` with the source tag so an identity build works.
 *   - Pull the system prompt / template / parameters verbatim. */
function formFromDetails(
  sourceName: string,
  d: OllamaShowResponse,
): ModelfileForm {
  const slug = sourceName.includes(":") ? sourceName.split(":")[0] : sourceName;
  return {
    name: `${slug}-custom`,
    from: sourceName,
    system: d.system ?? "",
    template: d.template ?? "",
    params: parseParamsBlock(d.parameters),
  };
}

function detailSummary(d: OllamaShowResponse | null): React.ReactNode {
  if (!d) return null;
  const bits: string[] = [];
  const dt = d.details as Record<string, unknown> | null | undefined;
  if (dt) {
    const fam = asString(dt.family);
    const psize = asString(dt.parameter_size);
    const qlevel = asString(dt.quantization_level);
    const fmt = asString(dt.format);
    if (fam) bits.push(fam);
    if (psize) bits.push(psize);
    if (qlevel) bits.push(qlevel);
    if (fmt) bits.push(fmt);
  }
  if (bits.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Info className="h-3 w-3" />
      {bits.join(" · ")}
    </span>
  );
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Params grid
// ---------------------------------------------------------------------------

/** Metadata drives the field list so we don't drift between the types and
 *  the UI. `hint` is optional — shown under the input so users know what a
 *  sensible range is without having to remember Ollama's docs. */
const NUMERIC_FIELDS: {
  key: Exclude<keyof ModelfileParams, "stop">;
  label: string;
  step?: number;
  hint?: string;
}[] = [
  { key: "temperature", label: "Temperature", step: 0.05, hint: "0 – 2" },
  { key: "top_p", label: "Top-P", step: 0.01, hint: "0 – 1" },
  { key: "top_k", label: "Top-K", step: 1 },
  { key: "min_p", label: "Min-P", step: 0.01, hint: "0 – 1" },
  { key: "num_ctx", label: "Context (num_ctx)", step: 256 },
  { key: "num_predict", label: "Max tokens (num_predict)", step: 16 },
  { key: "num_batch", label: "Batch size (num_batch)", step: 8 },
  { key: "num_gpu", label: "GPU layers (num_gpu)", step: 1 },
  { key: "num_thread", label: "CPU threads (num_thread)", step: 1 },
  { key: "repeat_penalty", label: "Repeat penalty", step: 0.05 },
  { key: "repeat_last_n", label: "Repeat look-back", step: 8 },
  { key: "frequency_penalty", label: "Frequency penalty", step: 0.05 },
  { key: "presence_penalty", label: "Presence penalty", step: 0.05 },
  { key: "tfs_z", label: "Tail-free (tfs_z)", step: 0.05 },
  { key: "typical_p", label: "Typical-P", step: 0.01 },
  { key: "mirostat", label: "Mirostat (0/1/2)", step: 1 },
  { key: "mirostat_eta", label: "Mirostat η", step: 0.05 },
  { key: "mirostat_tau", label: "Mirostat τ", step: 0.5 },
  { key: "seed", label: "Seed (blank = random)", step: 1 },
];

/**
 * Thinking toggle row for ModelsView. Three states the user might land in:
 *
 *   - **Capabilities still loading** (caps === null) — toggle disabled with
 *     a "loading" hint so the row doesn't briefly flash as "unsupported"
 *     between mount and the `/api/show` round-trip.
 *   - **Model doesn't support thinking** — toggle disabled with a
 *     "this model doesn't support thinking" explanation. Common case for
 *     non-reasoning models like llama3.x or mistral.
 *   - **Model supports thinking** — toggle live. Off-state means the user
 *     has explicitly disabled thinking; on-state means either an explicit
 *     pref or the model's natural default (Ollama's behaviour for
 *     thinking-capable models is to think unless told otherwise).
 *
 * The pref is stored in modelsStore (in-memory) and feeds into
 * `chatStore.readSessionParams` so all new chats with this model pick
 * it up. Per-chat overrides via the Parameter sidebar still win.
 */
function ThinkingSection({
  capabilities,
  pref,
  onChange,
}: {
  capabilities: string[] | null;
  pref: boolean | undefined;
  onChange: (next: boolean | null) => void;
}) {
  const loading = capabilities === null;
  const supports = !loading && capabilities.includes("thinking");
  // When the user hasn't set a preference, the natural default for
  // thinking-capable models is ON; for everything else we just show the
  // toggle as off (and disabled).
  const checked = pref ?? supports;
  const hint = loading
    ? "Reading model capabilities…"
    : supports
      ? pref === undefined
        ? "Using this model's default. Toggle to record an explicit preference for new chats."
        : "Default for new chats with this model. Per-chat overrides still apply via the Parameters sidebar."
      : "This model doesn't list a thinking capability — flipping the toggle would have no effect.";

  return (
    <div className={!supports || loading ? "opacity-65" : undefined}>
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm">
          {supports ? "Allow thinking step" : "Thinking — not supported"}
        </Label>
        <div className="flex items-center gap-2">
          {pref !== undefined && supports && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="rounded-md px-2 py-0.5 text-[11px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              title="Clear the override and follow the model's natural default"
            >
              Reset
            </button>
          )}
          <Switch
            checked={checked}
            disabled={!supports || loading}
            onCheckedChange={(next) => onChange(next)}
            aria-label={
              checked ? "Disable thinking for this model" : "Enable thinking for this model"
            }
          />
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-foreground/55">
        {hint}
      </p>
    </div>
  );
}

function ParamsGrid({
  params,
  onChange,
}: {
  params: ModelfileParams;
  onChange: (patch: Partial<ModelfileParams>) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {NUMERIC_FIELDS.map((f) => (
        <NumField
          key={f.key}
          label={f.label}
          hint={f.hint}
          step={f.step}
          value={params[f.key] ?? null}
          onChange={(v) => onChange({ [f.key]: v } as Partial<ModelfileParams>)}
        />
      ))}
    </div>
  );
}

function NumField({
  label,
  hint,
  value,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null;
  step?: number;
  onChange: (v: number | null) => void;
}) {
  // Keep the raw string in local state so a user typing "0." doesn't get
  // clobbered by a premature coerce. We only push a committed number up on
  // blur or when the parse is unambiguous.
  const [text, setText] = useState<string>(value === null ? "" : String(value));
  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      // Revert on garbage input rather than silently zeroing the field.
      setText(value === null ? "" : String(value));
      return;
    }
    onChange(n);
  };

  return (
    <div>
      <Label className="text-[11px] font-medium text-foreground/70">
        {label}
      </Label>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="(inherit)"
        className="mt-1 h-8 text-sm"
      />
      {hint && (
        <p className="mt-0.5 text-[10px] text-foreground/40">{hint}</p>
      )}
    </div>
  );
}

function StopEditor({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v, idx) => (
          <span
            key={`${v}-${idx}`}
            className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.08] px-2.5 py-1 font-mono text-[11px] text-foreground/80"
          >
            {v}
            <button
              type="button"
              onClick={() =>
                onChange(values.filter((_, i) => i !== idx))
              }
              className="text-foreground/50 hover:text-foreground"
              aria-label={`Remove stop sequence ${v}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={"<|eot|> or similar — Enter to add"}
          className="h-8 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={add}
          disabled={!draft.trim()}
          className="h-8"
        >
          Add
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-foreground/40">
        Each entry becomes a{" "}
        <span className="font-mono">PARAMETER stop &quot;…&quot;</span> line.
      </p>
    </div>
  );
}
