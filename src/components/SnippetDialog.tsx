import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  ollamaListModels,
  ollamaProbe,
  openaiListModels,
} from "@/lib/tauri";
import type { ModelInfo, ProviderId } from "@/types";

/**
 * Create / edit modal for a Snippet. Layout intentionally matches `SpaceForm`
 * so the "new/edit" surfaces across the app feel like the same dialog.
 *
 * Attachments are deliberately omitted right now — the DB column is kept for
 * forward compat but the UI surface is removed per product decision.
 */
export function SnippetDialog() {
  const target = useSnippetStore((s) => s.dialogTarget);
  const close = useSnippetStore((s) => s.closeDialog);
  const create = useSnippetStore((s) => s.create);
  const update = useSnippetStore((s) => s.update);

  const editing = target && target !== "new" ? target : null;
  const isEditMode = !!editing;

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed local state whenever we open the dialog (new or edit).
  useEffect(() => {
    if (!target) return;
    if (target === "new") {
      setTitle("");
      setPrompt("");
      setProvider(null);
      setModel(null);
    } else {
      setTitle(target.title);
      setPrompt(target.prompt);
      setProvider(target.provider);
      setModel(target.model);
    }
    setError(null);
  }, [target]);

  if (!target) return null;

  const handleCancel = () => {
    close();
  };

  const handleSave = async () => {
    const t = title.trim();
    const p = prompt.trim();
    if (!t) {
      setError("Title is required");
      return;
    }
    if (!p) {
      setError("Prompt is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEditMode && editing) {
        await update(editing.id, t, p, provider, model);
      } else {
        await create(t, p, provider, model);
      }
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={handleCancel}
      />

      <div className="relative z-10 w-full max-w-xl px-6">
        <button
          onClick={handleCancel}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-foreground/50 transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
          Close
        </button>

        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          {isEditMode ? "Edit snippet" : "New snippet"}
        </h1>
        <p className="mt-2 text-sm text-foreground/50">
          Save a prompt you send often. Optionally pin a default model so
          running the snippet picks it automatically.
        </p>

        <div className="mt-8 space-y-5">
          <div>
            <label
              htmlFor="snippet-title"
              className="mb-1.5 block text-sm font-medium text-foreground/70"
            >
              Title
            </label>
            <Input
              id="snippet-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Code review checklist"
              maxLength={80}
              autoFocus
              className="h-12 rounded-xl border-foreground/10 bg-foreground/[0.05] text-base"
            />
          </div>

          <div>
            <label
              htmlFor="snippet-prompt"
              className="mb-1.5 block text-sm font-medium text-foreground/70"
            >
              Prompt
            </label>
            <Textarea
              id="snippet-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Review the following code and flag any bugs, smells, or performance issues…"
              className="min-h-[140px] rounded-xl border-foreground/10 bg-foreground/[0.05]"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground/70">
              Default model{" "}
              <span className="font-normal text-foreground/40">(optional)</span>
            </label>
            <ModelPicker
              provider={provider}
              model={model}
              onClear={() => {
                setProvider(null);
                setModel(null);
              }}
              onSelect={(p, m) => {
                setProvider(p);
                setModel(m);
              }}
            />
            <p className="mt-1.5 text-[12px] text-foreground/45">
              When set, running this snippet starts a new chat with this model
              pre-selected. Leave blank to use the current default.
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={handleCancel} className="rounded-xl px-5">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !title.trim() || !prompt.trim()}
              className="rounded-xl px-5"
            >
              {saving
                ? isEditMode
                  ? "Saving…"
                  : "Creating…"
                : isEditMode
                  ? "Save changes"
                  : "Create snippet"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Thin wrapper around the same model-list fetching logic the ChatHeader uses.
 * Kept inline here because it's only ever used inside SnippetDialog; if a
 * third surface needs it we can lift it into its own component.
 */
function ModelPicker({
  provider,
  model,
  onSelect,
  onClear,
}: {
  provider: ProviderId | null;
  model: string | null;
  onSelect: (provider: ProviderId, model: string) => void;
  onClear: () => void;
}) {
  const settings = useSettingsStore();
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [openaiModels, setOpenaiModels] = useState<ModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const probe = await ollamaProbe(settings.ollama_base_url).catch(
          () => false,
        );
        setOllamaUp(probe);
        if (probe) {
          const m = await ollamaListModels(settings.ollama_base_url).catch(
            () => [],
          );
          setOllamaModels(m);
        } else {
          setOllamaModels([]);
        }
        if (settings.openai_key_set) {
          const m = await openaiListModels(settings.openai_base_url).catch(
            () => [],
          );
          setOpenaiModels(m);
        }
      } finally {
        setLoading(false);
      }
    },
    [settings.ollama_base_url, settings.openai_base_url, settings.openai_key_set],
  );

  useEffect(() => {
    if (!settings.hydrated) return;
    refresh();
  }, [settings.hydrated, refresh]);

  const label =
    provider && model ? `${model} · ${provider}` : "No default model";

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-12 flex-1 justify-between rounded-xl border border-foreground/10 bg-foreground/[0.05] px-3 text-left text-foreground/85 hover:bg-foreground/10 hover:text-foreground"
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[280px]">
          <div className="flex items-center justify-between px-2 py-1.5">
            <DropdownMenuLabel className="p-0">Models</DropdownMenuLabel>
            <button
              className="rounded p-1 hover:bg-accent"
              onClick={(e) => {
                e.preventDefault();
                refresh();
              }}
              aria-label="Refresh models"
            >
              <RefreshCw
                className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
              />
            </button>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-1.5">
            {ollamaUp ? (
              <CircleCheck className="h-3 w-3 text-emerald-500" />
            ) : (
              <CircleAlert className="h-3 w-3 text-amber-500" />
            )}
            Ollama
          </DropdownMenuLabel>
          {ollamaModels.length === 0 && (
            <DropdownMenuItem disabled>
              {ollamaUp ? "No models installed" : "Not running"}
            </DropdownMenuItem>
          )}
          {ollamaModels.map((m) => (
            <DropdownMenuItem
              key={`ollama:${m.id}`}
              onSelect={() => onSelect("ollama", m.id)}
            >
              {m.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>OpenAI</DropdownMenuLabel>
          {openaiModels.length === 0 && (
            <DropdownMenuItem disabled>
              {settings.openai_key_set ? "No models" : "API key not set"}
            </DropdownMenuItem>
          )}
          {openaiModels.slice(0, 30).map((m) => (
            <DropdownMenuItem
              key={`openai:${m.id}`}
              onSelect={() => onSelect("openai", m.id)}
            >
              {m.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {provider && model && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-9 shrink-0 rounded-lg px-3 text-foreground/65 hover:bg-foreground/10 hover:text-foreground"
        >
          Clear
        </Button>
      )}
    </div>
  );
}
