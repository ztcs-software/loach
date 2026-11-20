import { useMemo } from "react";
import { Check, Download, X, XCircle } from "lucide-react";
import { pullPercent } from "@/lib/usePullRuns";
import { useModelsStore } from "@/stores/modelsStore";
import { PullProgress } from "@/components/PullProgress";

/**
 * Thin download strip pinned to the bottom of every wizard step.
 *
 * The provider step deliberately lets the user walk away from a running pull,
 * but until this existed the download vanished from view the moment they hit
 * Continue — leaving a multi-gigabyte transfer running with no indication it
 * was happening, and a "You're all set" screen two steps later that wasn't
 * true yet. Mounted in StepShell so it follows the user through the rest of
 * the wizard; renders nothing when no pull was ever started.
 *
 * Finished pulls stay visible ("Downloaded" / "Failed") instead of the row
 * evaporating at 100% — a download that silently disappears reads as lost,
 * not done. Only cancelled pulls are dropped: the user dismissed those
 * themselves.
 */
export function PullStrip() {
  const runs = useModelsStore((s) => s.runs);
  const cancelRun = useModelsStore((s) => s.cancelRun);
  const pulls = useMemo(
    () =>
      Object.entries(runs)
        .filter(([, r]) => r.kind === "pull" && r.finished !== "cancelled")
        .map(([streamId, run]) => ({ streamId, run }))
        .sort((a, b) => a.streamId.localeCompare(b.streamId)),
    [runs],
  );
  if (pulls.length === 0) return null;

  const anyLive = pulls.some(({ run }) => run.finished === null);

  return (
    <div className="space-y-1.5 border-t border-foreground/[0.06] px-6 py-2.5">
      {pulls.map(({ streamId, run }) => {
        if (run.finished === "ok") {
          return (
            <div key={streamId} className="flex items-center gap-2.5">
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/75">
                {run.target}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
                Downloaded
              </span>
            </div>
          );
        }
        if (run.finished === "error") {
          return (
            <div
              key={streamId}
              className="flex items-center gap-2.5"
              title={run.error ?? undefined}
            >
              <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/75">
                {run.target}
              </span>
              {/* The reason on screen, not only in a mouse-only tooltip. */}
              <span className="min-w-0 max-w-[55%] truncate text-[11px] text-destructive">
                Failed{run.error ? `: ${run.error}` : ""}
              </span>
            </div>
          );
        }
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
              <PullProgress run={run} className="mt-1" />
            </div>
            {/* Stopping is low-cost: Ollama keeps the layers it already
                fetched, so a re-pull of the same tag resumes from them. No
                confirm dialog for the same reason. */}
            <button
              type="button"
              onClick={() => void cancelRun(streamId)}
              aria-label={`Stop downloading ${run.target}`}
              title="Stop download"
              className="shrink-0 rounded-md p-1 text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {anyLive && (
        <p className="text-[10.5px] leading-snug text-foreground/45">
          Downloading in the background — keep going, it'll finish on its own.
        </p>
      )}
    </div>
  );
}
