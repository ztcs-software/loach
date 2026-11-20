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
import { fullOllamaTag } from "@/lib/modelChoice";
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

/** The pulls of a session's model, oldest first, when they decide whether it
 *  can answer; otherwise null.
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
function pullsOf(
  runs: Record<string, AdminProgress>,
  installed: ModelInfo[],
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress[] | null {
  if (!model || provider !== "ollama") return null;
  // `llama3` and `llama3:latest` are one model, however each was typed.
  const tag = fullOllamaTag(model);
  if (installed.some((m) => fullOllamaTag(m.id) === tag)) return null;
  return Object.values(runs).filter((r) => r.kind === "pull" && fullOllamaTag(r.target) === tag);
}

/** The in-flight pull that makes a session's pinned model unusable, or null. */
function findBlockingPull(
  runs: Record<string, AdminProgress>,
  installed: ModelInfo[],
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  return pullsOf(runs, installed, provider, model)?.find((r) => r.finished === null) ?? null;
}

/** The pull of a session's model that last ended without it — failed or
 *  cancelled, with no retry since — or null. When that happened the download
 *  banner just vanished, and the next send got Ollama's 404 rendered as
 *  "endpoint or model not found", the message the banner exists to head off. */
export function findFailedPull(
  runs: Record<string, AdminProgress>,
  installed: ModelInfo[],
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  // Runs are kept in start order, so the last one is the latest attempt.
  const last = pullsOf(runs, installed, provider, model)?.at(-1);
  return last && (last.finished === "error" || last.finished === "cancelled") ? last : null;
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

/** Reactive {@link findFailedPull} for components. */
export function useFailedPullFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  const runs = useModelsStore((s) => s.runs);
  const installed = useModelsStore((s) => s.models);
  return useMemo(
    () => findFailedPull(runs, installed, provider, model),
    [runs, installed, provider, model],
  );
}

/** Non-reactive {@link findFailedPull}, for the send guard. */
export function getFailedPullFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): AdminProgress | null {
  const { runs, models } = useModelsStore.getState();
  return findFailedPull(runs, models, provider, model);
}

/** Completion percentage, or null while the daemon is still working out how
 *  much there is to fetch (both fields sit at 0 during manifest resolution). */
export function pullPercent(run: AdminProgress): number | null {
  if (run.total <= 0) return null;
  return Math.min(100, Math.round((run.completed / run.total) * 100));
}
