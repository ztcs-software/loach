import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { DefaultModelPicker } from "@/components/DefaultModelPicker";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSnippetVarStore } from "@/stores/snippetVarStore";
import { describePlaceholders, type PlaceholderInfo } from "@/lib/snippetVars";
import { dialogEnter } from "@/lib/shortcuts";
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
  const { confirm } = useConfirm();
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
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // What the fields held when the dialog opened — closing with anything else
  // asks first.
  const baseline = editing
    ? editing
    : { title: "", prompt: isSeed ? (target as { seedPrompt: string }).seedPrompt : "", provider: null, model: null };
  const dirty =
    title !== baseline.title ||
    prompt !== baseline.prompt ||
    provider !== baseline.provider ||
    model !== baseline.model;

  // Escape, the backdrop, ✕ and Cancel all come through here, so none of them
  // can throw a typed prompt away without asking.
  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: isEditMode ? "Your edits to this snippet haven't been saved." : "This snippet hasn't been saved yet.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      }))
    ) {
      return;
    }
    close();
  };

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

  const canSave = !saving && !!title.trim() && !!prompt.trim();

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
    <Dialog open={!!target} onOpenChange={(o) => !o && void requestClose()}>
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
          <Field label="Title">
            <Input
              id="snippet-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void handleSave(), { ready: canSave, next: promptRef.current })}
              placeholder="e.g. Code review checklist"
              maxLength={80}
              autoFocus
            />
          </Field>
          <Field label="Prompt">
            <Textarea
              ref={promptRef}
              id="snippet-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void handleSave(), { ready: canSave })}
              placeholder="Review the following code and flag any bugs, smells, or performance issues…"
              className="min-h-[120px] rounded-2xl border-foreground/10 bg-foreground/[0.05]"
            />
          </Field>
          <PlaceholderSummary prompt={prompt} />
          <Field label="Model" optional>
            <DefaultModelPicker
              provider={provider}
              model={model}
              onChange={(p, m) => {
                setProvider(p);
                setModel(m);
              }}
            />
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => void requestClose()} className="rounded-lg">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave} className="rounded-lg">
            {isEditMode ? (saving ? "Saving…" : "Save") : saving ? "Creating…" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const KIND_LABEL: Record<Exclude<PlaceholderInfo["kind"], "invalid">, string> = {
  builtin: "built-in",
  saved: "saved value",
  ask: "asked when run",
};

/**
 * What the prompt's `{{…}}` placeholders will do when the snippet runs, under
 * the prompt field. Nothing in the editor used to say which ones get filled
 * in, and a lower-case `{{topic}}` was silently sent to the model as typed.
 */
function PlaceholderSummary({ prompt }: { prompt: string }) {
  const variables = useSnippetVarStore((s) => s.variables);
  const found = useMemo(() => describePlaceholders(prompt, variables), [prompt, variables]);
  const invalid = found.filter((p) => p.kind === "invalid");
  const valid = found.filter((p) => p.kind !== "invalid");

  if (found.length === 0) {
    return (
      <p className="text-[11px] text-foreground/45">
        Add a <span className="font-mono">{"{{NAME}}"}</span> placeholder to be asked for a value
        each time the snippet runs.
      </p>
    );
  }
  return (
    <div className="space-y-1.5 text-[11px]">
      {valid.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {valid.map((p) => (
            <span
              key={p.name}
              className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-foreground/70"
            >
              <span className="font-mono">{`{{${p.name}}}`}</span>
              <span className="text-foreground/45">
                {KIND_LABEL[p.kind as Exclude<PlaceholderInfo["kind"], "invalid">]}
              </span>
            </span>
          ))}
        </div>
      )}
      {invalid.length > 0 && (
        <p className="text-amber-700 dark:text-amber-300">
          <span className="font-mono">{invalid.map((p) => `{{${p.name}}}`).join(", ")}</span>{" "}
          won't be filled in — variable names use
          capital letters, digits and _, like <span className="font-mono">{"{{TOPIC}}"}</span>.
        </p>
      )}
    </div>
  );
}
