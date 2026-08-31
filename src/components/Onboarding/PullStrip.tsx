import { Download } from "lucide-react";
import { useLivePulls, pullPercent } from "@/lib/usePullRuns";

/**
 * Thin "still downloading" strip pinned to the bottom of every wizard step.
 *
 * The provider step deliberately lets the user walk away from a running pull,
 * but until this existed the download vanished from view the moment they hit
 * Continue — leaving a multi-gigabyte transfer running with no indication it
 * was happening, and a "You're all set" screen two steps later that wasn't
 * true yet. Mounted in StepShell so it follows the user through the rest of
 * the wizard; renders nothing when no pull is in flight.
 */
export function PullStrip() {
  const pulls = useLivePulls();
  if (pulls.length === 0) return null;

  return (
    <div className="border-t border-foreground/[0.06] bg-foreground/[0.02] px-6 py-2.5">
      {pulls.map(({ streamId, run }) => {
        const pct = pullPercent(run);
        return (
          <div key={streamId} className="flex items-center gap-2.5">
            <Download className="h-3.5 w-3.5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[11.5px] text-foreground/75">
                  {run.target}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-foreground/50">
                  {pct === null ? run.status : `${pct}%`}
                </span>
              </div>
              <div
                className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
                role="progressbar"
                aria-label={`Downloading ${run.target}`}
                // An indeterminate bar reports no value at all rather than a
                // misleading 0%, which is what `aria-valuenow={0}` would say.
                aria-valuenow={pct ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={pct === null ? "h-full w-1/3 animate-pulse bg-primary" : "h-full bg-primary transition-all"}
                  style={pct === null ? undefined : { width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
      <p className="mt-1.5 text-[10.5px] leading-snug text-foreground/45">
        Downloading in the background — keep going, it'll finish on its own.
      </p>
    </div>
  );
}
