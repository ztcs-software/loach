// Subscriptions over `modelsStore.runs` for the surfaces that need to know a
// model download is still going.
//
// A pull started in onboarding routinely outlives the wizard — the whole point
// of letting the user continue while it downloads — so "is this model actually
// usable yet?" has to be answerable from the chat surface too, not just from
// the screen that started the pull. Without that, a first send lands on
// Ollama's 404 and gets rendered as "endpoint or model not found. Check the
// model name and URL", which is both wrong and the very first thing the app
// ever tells a new user.

import { useMemo } from "react";
import { useModelsStore, type AdminProgress } from "@/stores/modelsStore";

export interface LivePull {
  streamId: string;
  run: AdminProgress;
}

/** Every pull that hasn't reached a terminal state, in stable id order. */
export function useLivePulls(): LivePull[] {
  const runs = useModelsStore((s) => s.runs);
  return useMemo(
    () =>
      Object.entries(runs)
        .filter(([, r]) => r.kind === "pull" && r.finished === null)
        .map(([streamId, run]) => ({ streamId, run }))
        .sort((a, b) => a.streamId.localeCompare(b.streamId)),
    [runs],
  );
}

/** The in-flight pull for one model tag, or null. Used to answer "can this
 *  session send yet?" for the session's pinned model. */
export function useLivePullFor(model: string | null | undefined): AdminProgress | null {
  const runs = useModelsStore((s) => s.runs);
  return useMemo(() => {
    if (!model) return null;
    const hit = Object.values(runs).find(
      (r) => r.kind === "pull" && r.target === model && r.finished === null,
    );
    return hit ?? null;
  }, [runs, model]);
}

/** Non-reactive twin of {@link useLivePullFor} for store code, which can't
 *  call hooks. Reads the same `runs` map straight off the store. */
export function getLivePullFor(model: string): AdminProgress | null {
  const runs = useModelsStore.getState().runs;
  const hit = Object.values(runs).find(
    (r) => r.kind === "pull" && r.target === model && r.finished === null,
  );
  return hit ?? null;
}

/** Completion percentage, or null while the daemon is still working out how
 *  much there is to fetch (both fields sit at 0 during manifest resolution). */
export function pullPercent(run: AdminProgress): number | null {
  if (run.total <= 0) return null;
  return Math.min(100, Math.round((run.completed / run.total) * 100));
}
