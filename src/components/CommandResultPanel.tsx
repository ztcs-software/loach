import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommandResult } from "@/lib/commands/types";

/** Sits above the composer to surface list-style command output
 *  (`/list models`, `/tools`, `/fetch`, etc.). The composer owns the
 *  visibility state and clears it on the user's next send. Toast-style
 *  results (single-line confirmations and errors) bypass this panel and
 *  use the global toast host instead. */
export function CommandResultPanel({
  result,
  onDismiss,
}: {
  result: CommandResult;
  onDismiss: () => void;
}) {
  if (result.kind !== "list") return null;
  return (
    <div className="relative mb-3">
      <div
        className={cn(
          "rounded-2xl border border-foreground/10",
          "bg-popover/95 px-3 py-2.5 text-popover-foreground shadow-lg backdrop-blur-xl",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground/55">
            {result.title}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="grid h-5 w-5 place-items-center rounded-md text-foreground/45 hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-2 max-h-[200px] overflow-y-auto pr-1">
          <ul className="space-y-1">
            {result.items.map((item, i) => (
              <li
                key={i}
                className="flex items-baseline gap-2 rounded-md px-1.5 py-1 text-sm"
              >
                <span className="truncate text-foreground/90">{item.label}</span>
                {item.detail && (
                  <span className="shrink-0 text-[11px] text-foreground/50">
                    {item.detail}
                  </span>
                )}
                {item.hint && (
                  <span className="ml-auto truncate text-xs text-foreground/45">
                    {item.hint}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
