import { Download } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useLivePullFor, pullPercent } from "@/lib/usePullRuns";

/**
 * "Your model is still downloading" bar, shown above the composer whenever
 * the active chat is pinned to a model whose pull hasn't finished.
 *
 * Onboarding deliberately lets the user leave the wizard while a multi-gigabyte
 * pull runs, which means the very first chat they land in can be pointed at a
 * model that doesn't exist locally yet. Without this the only feedback was the
 * failed send — and Ollama's 404 for a missing tag reads as "endpoint or model
 * not found. Check the model name and URL", sending a brand-new user off to
 * debug a URL that was never wrong. `chatStore.sendUserMessage` blocks the send
 * with an accurate message; this is the part that stops them trying at all.
 *
 * Renders nothing in the normal case (no pull, or a pull for some other model).
 */
export function ModelDownloadBanner() {
  const model = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.model ?? null,
  );
  const provider = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.provider ?? null,
  );
  const pull = useLivePullFor(provider, model);
  if (!pull) return null;

  const pct = pullPercent(pull);
  return (
    <div className="mb-3 flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/[0.06] px-3.5 py-2.5">
      <Download className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[12.5px] text-foreground/85">
            Downloading <span className="font-mono">{pull.target}</span> — ready
            to chat once it finishes.
          </p>
          <span className="shrink-0 text-[11px] tabular-nums text-foreground/55">
            {pct === null ? pull.status : `${pct}%`}
          </span>
        </div>
        <div
          className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
          role="progressbar"
          aria-label={`Downloading ${pull.target}`}
          // Omitted rather than 0 while indeterminate — `aria-valuenow={0}`
          // would announce "0 percent" for a download that may be nearly done.
          aria-valuenow={pct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={
              pct === null
                ? "h-full w-1/3 animate-pulse bg-primary"
                : "h-full bg-primary transition-all"
            }
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
