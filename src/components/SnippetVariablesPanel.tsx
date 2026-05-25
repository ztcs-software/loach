import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { useSnippetVarStore } from "@/stores/snippetVarStore";
import { cn } from "@/lib/utils";
import type { SnippetVariable } from "@/types";

/**
 * Collapsible block above the snippet grid on the Snippets Library page.
 * Lists every user-defined variable as a single-line row (key, value, an
 * optional description) and lets the user add / edit / delete from here
 * without leaving the library.
 *
 * Collapsed by default so users who never define a variable don't have a
 * permanent chunk of unused chrome above their snippets — the chevron and
 * the count (when non-zero) hint that there's something to see.
 */
export function SnippetVariablesPanel() {
  const { confirm } = useConfirm();
  const variables = useSnippetVarStore((s) => s.variables);
  const openDialog = useSnippetVarStore((s) => s.openDialog);
  const remove = useSnippetVarStore((s) => s.remove);

  // Collapsed by default when there are no variables, expanded when there
  // are some — so users who already use the feature don't have to click
  // every time, while newcomers get a quiet header until they engage.
  // `useState`'s initialiser runs once before hydration completes (when
  // `variables` is still `[]`), so we also auto-expand the first time the
  // store reveals existing rows. Subsequent manual toggles are sticky for
  // the lifetime of the mount.
  const [expanded, setExpanded] = useState(variables.length > 0);
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (userToggled) return;
    if (variables.length > 0) setExpanded(true);
  }, [variables.length, userToggled]);

  const toggle = () => {
    setUserToggled(true);
    setExpanded((e) => !e);
  };

  const handleDelete = async (v: SnippetVariable) => {
    const ok = await confirm({
      title: `Delete variable {{${v.key}}}?`,
      body: "Any snippet using this variable will treat it as a prompt-on-use placeholder until you redefine it.",
      confirmLabel: "Delete variable",
      destructive: true,
    });
    if (ok) void remove(v.id);
  };

  return (
    <section className="mb-6 rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left",
          "transition-colors hover:bg-foreground/[0.03]",
        )}
        aria-expanded={expanded}
      >
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-foreground/55" />
          ) : (
            <ChevronRight className="h-4 w-4 text-foreground/55" />
          )}
          <h2 className="text-sm font-semibold text-foreground/85">
            Variables
          </h2>
          {variables.length > 0 && (
            <span className="text-[11px] text-foreground/45">
              {variables.length}
            </span>
          )}
          <span className="ml-2 hidden text-[11px] text-foreground/45 sm:inline">
            Reusable values for {`{{KEY}}`} placeholders inside snippets
          </span>
        </div>
        <span
          onClick={(e) => {
            e.stopPropagation();
            openDialog("new");
          }}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-foreground/15 px-2 text-[11px] text-foreground/75 hover:bg-foreground/10"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openDialog("new");
            }
          }}
        >
          <Plus className="h-3 w-3" />
          New
        </span>
      </button>

      {expanded && (
        <div className="border-t border-foreground/[0.06] px-4 py-3">
          {variables.length === 0 ? (
            <p className="py-2 text-xs text-foreground/50">
              No variables yet. Click <span className="font-medium">New</span>{" "}
              to define one — then reference it inside a snippet body as{" "}
              <span className="font-mono">{`{{KEY}}`}</span>.
            </p>
          ) : (
            <ul className="divide-y divide-foreground/[0.05]">
              {variables.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center gap-3 py-2 text-[13px]"
                >
                  <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground/75">
                    {`{{${v.key}}}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">
                    {v.value || (
                      <span className="italic text-foreground/40">
                        (empty)
                      </span>
                    )}
                  </span>
                  {v.description && (
                    <span className="hidden min-w-0 max-w-[40%] truncate text-[11px] text-foreground/45 md:inline">
                      {v.description}
                    </span>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openDialog(v)}
                      aria-label={`Edit ${v.key}`}
                      className="h-7 w-7 p-0 text-foreground/60"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(v)}
                      aria-label={`Delete ${v.key}`}
                      className="h-7 w-7 p-0 text-foreground/60 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
