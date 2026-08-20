import type { DownloadProgress } from "@/lib/updater";
import { cn } from "@/lib/utils";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Download progress for an in-flight update. Shared by the Settings →
 *  Updates panel and the launch-time "Update available" dialog so both
 *  surfaces report the same thing the same way. Falls back to an
 *  indeterminate-looking bar when the server didn't send a content length. */
export function UpdateProgressBar({ progress }: { progress: DownloadProgress }) {
  const { downloaded, total } = progress;
  const pct = total ? Math.min(100, (downloaded / total) * 100) : null;
  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-label="Update download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct === null ? {} : { "aria-valuenow": Math.round(pct) })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={cn(
            "h-full bg-primary transition-[width] duration-150 ease-out",
            // No content-length: a motionless 30% bar reads as stuck, so
            // pulse it the way ProviderStep does for the same case.
            pct === null && "animate-pulse",
          )}
          style={{ width: pct === null ? "30%" : `${pct}%` }}
        />
      </div>
      <div className="text-[11px] tabular-nums text-foreground/55">
        {pct === null
          ? `${formatBytes(downloaded)} downloaded`
          : `${formatBytes(downloaded)} / ${formatBytes(total!)} (${pct.toFixed(0)}%)`}
      </div>
    </div>
  );
}
