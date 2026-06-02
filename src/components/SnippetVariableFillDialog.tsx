import { useEffect, useMemo, useRef, useState } from "react";
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
import { applyFillValues } from "@/lib/snippetVars";

/**
 * Modal that appears when a snippet is run with `{{VAR}}` placeholders the
 * static pass couldn't resolve. One input per unresolved key; recall from
 * the previous run pre-fills the inputs when available. On submit, the
 * final substituted prompt is handed back to the expansion callback (which
 * lives in `lib/runSnippet.ts`) so the same code path can prime the
 * composer regardless of whether a fill was needed.
 *
 * Mounted once globally from `App.tsx` so any caller — Library tile,
 * search-bar hit, `/snippet` command — surfaces the same UX.
 */
export function SnippetVariableFillDialog() {
  const pending = useSnippetVarStore((s) => s.pendingFill);
  const setPending = useSnippetVarStore((s) => s.setPendingFill);

  // Local copy of the input values. Keyed by placeholder name. Initialised
  // from recall whenever a fresh `pending` request lands so reopening the
  // dialog after cancel starts from last-saved values instead of blank.
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!pending) return;
    const seeded: Record<string, string> = {};
    for (const key of pending.unresolved) {
      seeded[key] = pending.recall[key] ?? "";
    }
    setValues(seeded);
  }, [pending]);

  // Auto-focus the first empty input on open. If every input is pre-filled
  // from recall, focus the first one anyway so the user can tab through.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [pending]);

  const canSubmit = useMemo(() => {
    if (!pending) return false;
    // Every key must have a non-empty value before we let the user run the
    // snippet. Empty placeholder = ambiguous intent (did the user want to
    // skip it, or did they not see the field?), so we block submit instead
    // of silently sending `{{KEY}}` to the model.
    return pending.unresolved.every((k) => (values[k] ?? "").trim().length > 0);
  }, [pending, values]);

  if (!pending) return null;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const finalPrompt = applyFillValues(pending.partiallyResolved, values);
    pending.onSubmit(finalPrompt, values);
    setPending(null);
  };

  const handleCancel = () => {
    pending.onCancel();
    setPending(null);
  };

  return (
    <Dialog
      open={true}
      onOpenChange={(o) => {
        if (!o) handleCancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fill in snippet variables</DialogTitle>
          <DialogDescription>
            “{pending.snippetTitle}” has{" "}
            {pending.unresolved.length === 1
              ? "a placeholder"
              : `${pending.unresolved.length} placeholders`}{" "}
            that need a value before it can run.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {pending.unresolved.map((key, idx) => (
            <label key={key} className="block space-y-1.5">
              <span className="font-mono text-[11px] text-foreground/65">
                {`{{${key}}}`}
              </span>
              <Input
                ref={idx === 0 ? firstInputRef : undefined}
                value={values[key] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [key]: e.target.value }))
                }
                placeholder={`Value for ${key}`}
                onKeyDown={(e) => {
                  // Enter on the last field submits; on earlier fields it
                  // moves focus forward. Matches the typical "form" muscle
                  // memory without trapping Shift+Tab navigation.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (idx === pending.unresolved.length - 1) {
                      handleSubmit();
                    } else {
                      const next = e.currentTarget
                        .closest("div")
                        ?.parentElement?.querySelectorAll<HTMLInputElement>(
                          "input",
                        );
                      next?.[idx + 1]?.focus();
                    }
                  }
                }}
              />
            </label>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={handleCancel} className="rounded-lg">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="rounded-lg"
          >
            Run snippet
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
