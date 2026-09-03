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
import type { ModelInfo } from "@/types";

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

/** The in-flight pull that makes a session's pinned model unusable, or null.
 *
 *  Two qualifiers, because a run's `target` is only a string and "a pull is
 *  running for this name" isn't the same as "this model can't answer yet":
 *
 *    * the session has to be on Ollama — nothing else creates pull runs, and an
 *      OpenAI-compatible endpoint can serve a model id spelled like a tag;
 *    * the tag must not already be installed — re-pulling a resident tag is how
 *      Ollama updates it, and it keeps serving the existing copy until the new
 *      manifest lands, so there is nothing to wait for.
 */
function findBlockingPull(
  runs: Record<string, AdminProgress>,
  installed: ModelInfo[],
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  if (!model || provider !== "ollama") return null;
  if (installed.some((m) => m.id === model)) return null;
  return (
    Object.values(runs).find(
      (r) => r.kind === "pull" && r.target === model && r.finished === null,
    ) ?? null
  );
}

/** Reactive {@link findBlockingPull} for components. */
export function useLivePullFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  const runs = useModelsStore((s) => s.runs);
  const installed = useModelsStore((s) => s.models);
  return useMemo(
    () => findBlockingPull(runs, installed, provider, model),
    [runs, installed, provider, model],
  );
}

/** Non-reactive twin of {@link useLivePullFor} for store code, which can't
 *  call hooks. Reads the same state straight off the store. */
export function getLivePullFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  const { runs, models } = useModelsStore.getState();
  return findBlockingPull(runs, models, provider, model);
}

/** Completion percentage, or null while the daemon is still working out how
 *  much there is to fetch (both fields sit at 0 during manifest resolution). */
export function pullPercent(run: AdminProgress): number | null {
  if (run.total <= 0) return null;
  return Math.min(100, Math.round((run.completed / run.total) * 100));
}
