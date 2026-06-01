import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSnippetVarStore } from "@/stores/snippetVarStore";
import { RESERVED_VAR_KEYS } from "@/lib/snippetVars";

/**
 * Create / edit modal for a user-defined snippet variable. Mirrors
 * `SnippetDialog`'s shell so create/edit popups feel consistent. Key
 * validation (uppercase identifier + reserved-name block) mirrors the
 * server's `normalise_var_key` — the server is the source of truth, but
 * the inline check keeps the save button honest before the round-trip.
 */
export function SnippetVariableDialog() {
  const target = useSnippetVarStore((s) => s.dialogTarget);
  const close = useSnippetVarStore((s) => s.closeDialog);
  const create = useSnippetVarStore((s) => s.create);
  const update = useSnippetVarStore((s) => s.update);
  const variables = useSnippetVarStore((s) => s.variables);

  const editing = target && target !== "new" ? target : null;
  const isEditMode = !!editing;

  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    if (target === "new") {
      setKey("");
      setValue("");
      setDescription("");
    } else {
      setKey(target.key);
      setValue(target.value);
      setDescription(target.description ?? "");
    }
    setError(null);
  }, [target]);

  // Inline validation — exposed to the user as they type so they don't only
  // discover the rule via the save-time error toast.
  const inlineKeyError = (() => {
    const k = key.trim();
    if (k.length === 0) return null; // empty handled by disabled-button
    if (k.length > 64) return "Max 64 characters";
    const upper = k.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(upper)) {
      return "Use letters, digits, and underscores only (must start with a letter or _)";
    }
    if (RESERVED_VAR_KEYS.includes(upper)) {
      return `'${upper}' is reserved by Loach`;
    }
    // Catch a duplicate key BEFORE the save round-trip — the `key` column is
    // UNIQUE, so otherwise the user would see a raw "UNIQUE constraint
    // failed" SQLite string from the backend. Exclude the row being edited
    // (renaming a variable to its own current key is fine).
    if (variables.some((v) => v.key === upper && v.id !== editing?.id)) {
      return `'${upper}' already exists — pick a different name`;
    }
    return null;
  })();

  const handleSave = async () => {
    const k = key.trim().toUpperCase();
    const v = value;
    if (!k) {
      setError("Key is required");
      return;
    }
    if (inlineKeyError) {
      setError(inlineKeyError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trimmedDesc = description.trim();
      if (isEditMode && editing) {
        await update(editing.id, k, v, trimmedDesc || null);
      } else {
        await create(k, v, trimmedDesc || null);
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit variable" : "New variable"}
          </DialogTitle>
          <DialogDescription>
            Use it inside a snippet as <span className="font-mono">{`{{KEY}}`}</span>.
            Substituted automatically when the snippet runs.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-foreground/65">
              Key
            </span>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              placeholder="COMPANY"
              maxLength={64}
              autoFocus
              className="font-mono"
            />
            {inlineKeyError && (
              <span className="text-[11px] text-amber-500">
                {inlineKeyError}
              </span>
            )}
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-foreground/65">
              Value
            </span>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Acme Corp"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-foreground/65">
              Description{" "}
              <span className="font-normal text-foreground/45">(optional)</span>
            </span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this variable is for"
            />
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={close} className="rounded-lg">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !key.trim() || !!inlineKeyError}
            className="rounded-lg"
          >
            {saving ? (isEditMode ? "Saving…" : "Creating…") : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
