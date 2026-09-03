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

/** Runtime memory needed on top of the weights: KV cache, compute buffers,
 *  and the runner's own allocations. This grows with layer count and context,
 *  not with weight bytes, so it's modeled as a floor plus a small fraction.
 *  The flat ×1.2 multiplier it replaces charged a 25 GB model 5 GB of phantom
 *  overhead — enough to misfile MoE models that run well on a 32 GB machine
 *  as "won't fit" — while granting a 1 GB model almost nothing. */
const OVERHEAD_FRACTION = 0.15;
const OVERHEAD_FLOOR_GB = 0.8;

/** RAM we refuse to count as available for a model: the OS, the browser
 *  engine Loach itself runs on, and whatever else the user has open. There is
 *  no VRAM equivalent — the runner already keeps ~1 GB of VRAM free when it
 *  fits layers to the card, so reserving again here double-counted and pushed
 *  every verdict a tier down. */
const OS_RESERVE_GB = 3;

/** Fraction of a budget a model may need and still be called comfortable.
 *  Above it (but under 100%) the model runs, just with little headroom. */
const COMFORT_FRACTION = 0.8;

/** Free disk we leave unclaimed after a pull, so a download can't fill the
 *  volume to literally zero. */
const DISK_SLACK_GB = 2;

/** What the sizing helpers need to know about a model. Download size alone is
 *  not enough — two architectures deliberately decouple the download from the
 *  memory that matters, in opposite directions. */
export interface SizedVariant {
  /** On-disk footprint after the pull, in GB. What the disk check bills, and
   *  the amount that must fit in system RAM when a model overflows the GPU
   *  (weights are mmapped from RAM regardless of where they execute). */
  sizeGb: number;
  /** Accelerator-resident share of the weights, when an architecture keeps
   *  part of itself off the accelerator by design (Gemma's E-variants leave
   *  their per-layer embeddings in system RAM). Omitted means "same as the
   *  download", which is right for ordinary dense models. */
  residentGb?: number;
  /** Mixture-of-experts: only a few billion parameters are active per token.
   *  Doesn't change how much memory the weights occupy — every expert must be
   *  held — but changes what overflowing VRAM means: a dense model spilling
   *  to RAM crawls, a small-active MoE split across GPU and RAM is in its
   *  designed-for mode and stays quick. */
  moe?: boolean;
}

/**
 * How well a model sits on this machine, measured against whichever budget
 * actually binds — VRAM when there's a discrete GPU, system RAM otherwise.
 *
 *   - `comfortable` — runs with room to spare.
 *   - `tight`       — fits, but leaves little headroom.
 *   - `offload`     — bigger than VRAM, yet the weights fit in RAM. Ollama
 *                     still runs it with the overflow on the CPU. For a dense
 *                     model that costs most of the generation speed; for a
 *                     MoE model (`moeSplit` on the verdict) the split stays
 *                     quick and the UI says so instead of warning. Only
 *                     reachable when a GPU was detected — without one there
 *                     is nothing to spill out of.
 *   - `heavy`       — needs more memory than the machine has at all.
 */
export type FitTier = "comfortable" | "tight" | "offload" | "heavy";

export interface FitVerdict {
  tier: FitTier;
  /** Estimated peak memory in GB, against whichever budget applies. Shown in
   *  the "needs ~14 GB" badge. */
  requiredGb: number;
  /** True for an `offload` verdict on a MoE model: the GPU/CPU split is the
   *  mode the model is built for, so the badge reads as good news rather
   *  than as a performance warning. */
  moeSplit: boolean;
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
 * VRAM and runs the rest on the CPU.
 *
 * Three quantities per variant, deliberately distinct:
 *
 *   - the download (`sizeGb`) is billed to the disk check, and is the bound
 *     for the offload/heavy line — weights are mmapped from system RAM, so
 *     "runnable at all" means the download fits in RAM, with no overhead
 *     multiplier inflating it;
 *   - the resident share (`residentGb ?? sizeGb`) is what must sit on the
 *     accelerator, and drives the comfortable/tight verdicts;
 *   - the estimated requirement adds KV-cache-and-buffers overhead on top of
 *     the resident share.
 */
export function classifyFit(variant: SizedVariant, host: HostCapacity): FitVerdict {
  const residentGb = variant.residentGb ?? variant.sizeGb;
  const requiredGb = residentGb * (1 + OVERHEAD_FRACTION) + OVERHEAD_FLOOR_GB;
  const ramGb = Math.max(0, host.totalRamBytes / BYTES_PER_GB - OS_RESERVE_GB);
  const vramGb = host.vramBytes === null ? null : host.vramBytes / BYTES_PER_GB;
  const budgetGb = vramGb ?? ramGb;

  const tier: FitTier =
    requiredGb <= budgetGb * COMFORT_FRACTION
      ? "comfortable"
      : requiredGb <= budgetGb
        ? "tight"
        : // Overflowing VRAM is survivable when the full weights fit in RAM —
          // the excess runs on the CPU. With no GPU there is no such middle
          // ground: past RAM it simply won't fit.
          vramGb !== null && variant.sizeGb <= ramGb
          ? "offload"
          : "heavy";

  const freeDiskGb =
    host.freeDiskBytes === null ? null : host.freeDiskBytes / BYTES_PER_GB;
  const insufficientDisk =
    freeDiskGb !== null && variant.sizeGb > freeDiskGb - DISK_SLACK_GB;

  return {
    tier,
    requiredGb,
    moeSplit: tier === "offload" && (variant.moe ?? false),
    insufficientDisk,
  };
}

/**
 * Pick the variant to recommend: the largest one that still rates
 * `comfortable`, on the assumption that within a catalog of current models
 * more weights means a better answer. Variants that won't fit on disk are
 * never recommended.
 *
 * "Largest" is by resident size, not download — that's the axis capability
 * tracks, and it keeps an E-variant's fat download from outranking a model
 * that genuinely uses more of the card.
 *
 * Falls back to the smallest variant when nothing is comfortable, so a
 * low-RAM machine still gets a concrete suggestion (carrying an honest
 * `tight` / `heavy` badge) rather than an empty recommendation slot.
 *
 * Returns null only for an empty candidate list.
 */
export function recommendVariant<T extends SizedVariant & { tag: string }>(
  variants: T[],
  host: HostCapacity,
): T | null {
  if (variants.length === 0) return null;

  const fit = (v: T) => classifyFit(v, host);
  const resident = (v: T) => v.residentGb ?? v.sizeGb;

  const affordable = variants.filter((v) => !fit(v).insufficientDisk);
  // Every variant is too big for the disk — recommending one the user can't
  // download helps nobody, so fall through to the smallest and let the disk
  // badge explain itself.
  const pool = affordable.length > 0 ? affordable : variants;

  const comfortable = pool.filter((v) => fit(v).tier === "comfortable");
  if (comfortable.length > 0) {
    return comfortable.reduce((best, v) =>
      resident(v) > resident(best) ? v : best,
    );
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
