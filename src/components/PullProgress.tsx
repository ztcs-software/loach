import { cn } from "@/lib/utils";
import { pullPercent } from "@/lib/usePullRuns";
import type { AdminProgress } from "@/stores/modelsStore";

/** A model run's progress bar: filled to the share done once the size is
 *  known, a pulse before that. One for every surface that shows a pull — the
 *  Models page's run chips and the wizard drew theirs as bare divs, which a
 *  screen reader said nothing about. */
export function PullProgress({ run, className }: { run: AdminProgress; className?: string }) {
  const pct = pullPercent(run);
  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]", className)}
      role="progressbar"
      aria-label={`${run.kind === "pull" ? "Downloading" : "Creating"} ${run.target}`}
      // Omitted rather than 0 while indeterminate — `aria-valuenow={0}`
      // would announce "0 percent" for a download that may be nearly done.
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={pct === null ? "h-full w-1/3 animate-pulse bg-primary" : "h-full bg-primary transition-all"}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
