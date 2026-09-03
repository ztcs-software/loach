import { useEffect, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useProviderModels } from "@/lib/useProviderModels";
import type { ProviderId } from "@/types";

/**
 * Create / edit modal for a Snippet. Uses the same compact `Dialog` shell as
 * the rename-chat surface so creation/edit popups feel consistent across the
 * app.
 *
 * Attachments are deliberately omitted — the DB column is kept for forward
 * compat but the UI surface is removed per product decision.
 */
export function SnippetDialog() {
  const target = useSnippetStore((s) => s.dialogTarget);
  const close = useSnippetStore((s) => s.closeDialog);
  const create = useSnippetStore((s) => s.create);
  const update = useSnippetStore((s) => s.update);

  const isSeed =
    target !== null &&
    target !== "new" &&
    typeof target === "object" &&
    "seedPrompt" in target;
  const editing =
    target && target !== "new" && !isSeed
      ? (target as Exclude<typeof target, "new" | null | { seedPrompt: string }>)
      : null;
  const isEditMode = !!editing;

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    if (target === "new") {
      setTitle("");
      setPrompt("");
      setProvider(null);
      setModel(null);
    } else if (isSeed) {
      setTitle("");
      setPrompt((target as { seedPrompt: string }).seedPrompt);
      setProvider(null);
      setModel(null);
    } else if (editing) {
      setTitle(editing.title);
      setPrompt(editing.prompt);
      setProvider(editing.provider);
      setModel(editing.model);
    }
    setError(null);
  }, [target, isSeed, editing]);

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
    <Dialog open={!!target} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit snippet" : "New snippet"}
          </DialogTitle>
          <DialogDescription>
            Save a prompt you send often. Optionally pin a default model so
            running the snippet picks it automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <Input
            id="snippet-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title — e.g. Code review checklist"
            maxLength={80}
            autoFocus
          />
          <Textarea
            id="snippet-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Review the following code and flag any bugs, smells, or performance issues…"
            className="min-h-[120px] rounded-2xl border-foreground/10 bg-foreground/[0.05]"
          />
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
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={close} className="rounded-lg">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !title.trim() || !prompt.trim()}
            className="rounded-lg"
          >
            {saving
              ? isEditMode
                ? "Saving…"
                : "Creating…"
              : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  // Slice the store: this picker only needs the four fields that gate
  // model loading. Subscribing to the whole settings object would
  // re-render the dialog on every keystroke in the global SettingsDialog
  // textareas.
  const openaiKeySet = useSettingsStore((s) => s.openai_key_set);
  const { ollamaModels, openaiModels, ollamaUp, loading, refresh } =
    useProviderModels();

  const label =
    provider && model ? `${model} · ${provider}` : "No default model";

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 flex-1 justify-between rounded-2xl border border-foreground/10 bg-foreground/[0.05] px-4 text-left text-foreground/85 hover:bg-foreground/10 hover:text-foreground"
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
          <DropdownMenuLabel>API</DropdownMenuLabel>
          {openaiModels.length === 0 && (
            <DropdownMenuItem disabled>
              {openaiKeySet ? "No models" : "Not connected"}
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
