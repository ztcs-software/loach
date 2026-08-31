// Helpers for picking a model during onboarding.
//
// Two related jobs live here, both pure so they can be unit-tested without a
// Tauri runtime:
//
//   1. Sizing a local Ollama catalog entry against the host, so the wizard can
//      recommend one variant instead of listing seventeen and leaving a
//      newcomer to guess which of them their laptop can run.
//   2. Ranking a remote provider's model list, so the "default model" picker
//      pre-selects something chat-shaped rather than whatever the endpoint
//      happened to return first (`/v1/models` on api.openai.com is not sorted
//      in any useful order, and its first entry is routinely an embedding or
//      audio model).

import type { ModelInfo } from "@/types";

const BYTES_PER_GB = 1024 ** 3;

/** Multiplier from on-disk weight size to peak resident size. Weights are
 *  mmapped roughly 1:1; the rest is KV cache, the runner's own buffers, and
 *  the context window. 1.2 is deliberately optimistic-but-not-silly — this
 *  drives a recommendation, not an admission check. */
const RUNTIME_OVERHEAD = 1.2;

/** RAM we refuse to count as available for a model: the OS, the browser
 *  engine Loach itself runs on, and whatever else the user has open. */
const OS_RESERVE_GB = 3;

/** VRAM we refuse to count: the desktop compositor, the browser, and anything
 *  else already drawing on the card. Much smaller than the RAM reserve because
 *  a GPU isn't also running the OS. */
const VRAM_RESERVE_GB = 1;

/** Fraction of usable RAM a model may need and still be called comfortable.
 *  Above it (but under 100%) the model runs, just with everything else on the
 *  machine competing for what's left. */
const COMFORT_FRACTION = 0.8;

/** Free disk we leave unclaimed after a pull, so a download can't fill the
 *  volume to literally zero. */
const DISK_SLACK_GB = 2;

/**
 * How well a model sits on this machine, measured against whichever budget
 * actually binds — VRAM when there's a discrete GPU, system RAM otherwise.
 *
 *   - `comfortable` — runs with room to spare.
 *   - `tight`       — fits, but leaves little headroom.
 *   - `offload`     — bigger than VRAM yet within RAM. Ollama will still run
 *                     it, putting the layers that don't fit on the CPU, so it
 *                     works but generates far slower. Only reachable when a
 *                     GPU was detected; without one there is nothing to spill
 *                     out of.
 *   - `heavy`       — needs more memory than the machine has at all.
 */
export type FitTier = "comfortable" | "tight" | "offload" | "heavy";

export interface FitVerdict {
  tier: FitTier;
  /** Estimated peak memory in GB, against whichever budget applies. Shown in
   *  the "needs ~14 GB" badge. */
  requiredGb: number;
  /** True only when free disk is *known* and too small to hold the download.
   *  Unknown disk (null from the backend) is never reported as insufficient —
   *  blocking a pull on a number we don't have would be worse than letting
   *  the pull fail with a real error. */
  insufficientDisk: boolean;
}

/** The slice of `SystemInfo` this module needs. Taking the narrow shape (not
 *  `SystemInfo`) keeps the tests free of fields they don't exercise. */
export interface HostCapacity {
  totalRamBytes: number;
  freeDiskBytes: number | null;
  /** Dedicated VRAM of a discrete GPU, or null when there is none (CPU-only,
   *  integrated graphics, or Apple's unified memory — in all three cases RAM
   *  is already the right number). */
  vramBytes: number | null;
}

/** Which capacity the recommendation was sized against, for display. A user
 *  with a discrete GPU shown a RAM-derived figure is being told about the
 *  wrong constraint, so the UI names the one actually used. */
export interface CapacityBasis {
  kind: "vram" | "ram";
  /** The raw installed figure in GB — not minus the reserve, since this is
   *  what the user recognises as "my machine has X". */
  totalGb: number;
}

export function capacityBasis(host: HostCapacity): CapacityBasis {
  return host.vramBytes !== null
    ? { kind: "vram", totalGb: host.vramBytes / BYTES_PER_GB }
    : { kind: "ram", totalGb: host.totalRamBytes / BYTES_PER_GB };
}

/**
 * Classify one catalog variant against the host.
 *
 * The budget is VRAM whenever a discrete GPU was found, because that is what
 * decides whether a model is pleasant to use: Ollama fits what it can into
 * VRAM and runs the rest on the CPU, so a 18 GB model on an 8 GB card "fits in
 * RAM" and still crawls. Sizing against RAM alone recommended exactly that.
 */
export function classifyFit(sizeGb: number, host: HostCapacity): FitVerdict {
  const requiredGb = sizeGb * RUNTIME_OVERHEAD;
  const ramGb = Math.max(0, host.totalRamBytes / BYTES_PER_GB - OS_RESERVE_GB);
  const vramGb =
    host.vramBytes === null
      ? null
      : Math.max(0, host.vramBytes / BYTES_PER_GB - VRAM_RESERVE_GB);
  const budgetGb = vramGb ?? ramGb;

  const tier: FitTier =
    requiredGb <= budgetGb * COMFORT_FRACTION
      ? "comfortable"
      : requiredGb <= budgetGb
        ? "tight"
        : // Overflowing VRAM is survivable — the excess runs on the CPU. With
          // no GPU there is no such middle ground: past RAM it simply won't fit.
          vramGb !== null && requiredGb <= ramGb
          ? "offload"
          : "heavy";

  const freeDiskGb =
    host.freeDiskBytes === null ? null : host.freeDiskBytes / BYTES_PER_GB;
  const insufficientDisk =
    freeDiskGb !== null && sizeGb > freeDiskGb - DISK_SLACK_GB;

  return { tier, requiredGb, insufficientDisk };
}

/**
 * Pick the variant to recommend: the largest one that still rates
 * `comfortable`, on the assumption that within a catalog of current models
 * more weights means a better answer. Variants that won't fit on disk are
 * never recommended.
 *
 * Falls back to the smallest variant when nothing is comfortable, so a
 * low-RAM machine still gets a concrete suggestion (carrying an honest
 * `tight` / `heavy` badge) rather than an empty recommendation slot.
 *
 * Returns null only for an empty candidate list.
 */
export function recommendVariant<T extends { tag: string; sizeGb: number }>(
  variants: T[],
  host: HostCapacity,
): T | null {
  if (variants.length === 0) return null;

  const affordable = variants.filter(
    (v) => !classifyFit(v.sizeGb, host).insufficientDisk,
  );
  // Every variant is too big for the disk — recommending one the user can't
  // download helps nobody, so fall through to the smallest and let the disk
  // badge explain itself.
  const pool = affordable.length > 0 ? affordable : variants;

  const comfortable = pool.filter(
    (v) => classifyFit(v.sizeGb, host).tier === "comfortable",
  );
  if (comfortable.length > 0) {
    return comfortable.reduce((best, v) => (v.sizeGb > best.sizeGb ? v : best));
  }
  return pool.reduce((best, v) => (v.sizeGb < best.sizeGb ? v : best));
}

/** Model ids that are served by an OpenAI-compatible `/v1/models` listing but
 *  aren't chat models. Matched case-insensitively against the id. Kept narrow
 *  on purpose: a false positive demotes a model the user may actually want,
 *  and the list is a ranking hint, not a filter — nothing is ever hidden. */
const NON_CHAT_PATTERN =
  /(embed|whisper|tts|text-to-speech|speech|transcrib|audio|dall-?e|moderation|rerank|guard|^clip|image)/i;

/**
 * Sort a provider's models so the most plausible chat model comes first,
 * preserving the endpoint's own order within each group. Nothing is removed —
 * a self-hosted proxy may serve exactly one model whose name trips the
 * pattern, and hiding it would leave the picker empty.
 */
export function rankChatModels(models: ModelInfo[]): ModelInfo[] {
  const chat: ModelInfo[] = [];
  const rest: ModelInfo[] = [];
  for (const m of models) {
    (NON_CHAT_PATTERN.test(m.id) ? rest : chat).push(m);
  }
  return [...chat, ...rest];
}

/** Format a GB figure for display: one decimal under 10 GB, whole numbers
 *  above, so the catalog reads "~3.4 GB" but "~18 GB". */
export function formatGb(gb: number): string {
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/** Bytes → GB for display of a host figure (RAM, free disk). */
export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}
