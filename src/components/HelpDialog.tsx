import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUIStore } from "@/stores/uiStore";
import { COMMANDS } from "@/lib/commands/registry";
import type { CommandSpec } from "@/lib/commands/types";
import { cn } from "@/lib/utils";

/** Reference popup shown by `/help`. Groups commands by their `group`
 *  label and renders a scannable two-column list (name + usage on the left,
 *  description muted on the right). Matches the SettingsDialog style — same
 *  glass-panel chrome, same close affordance — so it doesn't feel like a
 *  bolted-on surface. */
export function HelpDialog() {
  const open = useUIStore((s) => s.helpOpen);
  const setOpen = useUIStore((s) => s.setHelpOpen);

  // Preserve registry order within each group. The Map preserves insertion
  // order so the section headers appear in the same order commands first
  // appear in `COMMANDS`.
  const groups = useMemo(() => {
    const m = new Map<string, CommandSpec[]>();
    for (const cmd of COMMANDS) {
      const key = cmd.group ?? "Other";
      const bucket = m.get(key);
      if (bucket) bucket.push(cmd);
      else m.set(key, [cmd]);
    }
    return Array.from(m.entries());
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Slash commands</DialogTitle>
          <DialogDescription>
            Type <kbd className="font-mono text-foreground/80">/</kbd> in the
            composer to filter.{" "}
            <kbd className="font-mono text-foreground/80">↑↓</kbd> navigates,{" "}
            <kbd className="font-mono text-foreground/80">Tab</kbd> or{" "}
            <kbd className="font-mono text-foreground/80">Enter</kbd> accepts,{" "}
            <kbd className="font-mono text-foreground/80">Esc</kbd> dismisses.
            Unknown commands send as regular messages.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {groups.map(([groupName, items], gi) => (
            <section
              key={groupName}
              className={cn(gi > 0 && "mt-4")}
            >
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
                {groupName}
              </div>
              <ul className="space-y-0.5">
                {items.map((cmd) => (
                  <li
                    key={cmd.name}
                    className="flex items-baseline gap-3 rounded-md px-2 py-1 text-sm hover:bg-foreground/[0.04]"
                  >
                    <span className="font-mono text-[13px] text-foreground">
                      /{cmd.name}
                      {cmd.usage && (
                        <span className="ml-1 text-foreground/45">{cmd.usage}</span>
                      )}
                    </span>
                    {cmd.subcommands && cmd.subcommands.length > 0 && !cmd.usage && (
                      <span className="font-mono text-[12px] text-foreground/45">
                        {cmd.subcommands.join(" | ")}
                      </span>
                    )}
                    <span className="ml-auto truncate text-xs text-foreground/55">
                      {cmd.description}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
