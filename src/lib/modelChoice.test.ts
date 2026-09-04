// The onboarding model recommendation is the one place where a wrong number
// is worse than no number: a newcomer who takes the suggestion and then
// watches their machine swap for ten minutes has been actively misled. These
// tests pin the tier boundaries and the "largest that still fits" pick against
// the real catalog sizes the wizard ships.

import { describe, it, expect } from "vitest";
import {
  capacityBasis,
  classifyFit,
  formatGb,
  rankChatModels,
  recommendVariant,
  type HostCapacity,
} from "./modelChoice";
import type { ModelInfo } from "@/types";

const GB = 1024 ** 3;

/** A machine with no discrete GPU — RAM is the binding constraint. */
const host = (ramGb: number, diskGb: number | null = 500): HostCapacity => ({
  totalRamBytes: ramGb * GB,
  freeDiskBytes: diskGb === null ? null : diskGb * GB,
  vramBytes: null,
});

/** A machine with a discrete GPU, where VRAM binds instead. */
const gpuHost = (
  ramGb: number,
  vramGb: number,
  diskGb: number | null = 500,
): HostCapacity => ({
  totalRamBytes: ramGb * GB,
  freeDiskBytes: diskGb === null ? null : diskGb * GB,
  vramBytes: vramGb * GB,
});

/** Shorthand: a plain dense variant is just its download size. */
const dense = (sizeGb: number) => ({ sizeGb });

/**
 * Representative variant sizes spanning the shipped catalog's range, smallest
 * to largest resident footprint. Deliberately a *sample* rather than a mirror
 * of OLLAMA_CATALOG: these tests pin the sizing math, so binding them to the
 * live catalog would break every expectation below each time a family is
 * added or dropped. Tags are real ones so a failure names something
 * recognisable, and the resident/MoE annotations match the shipped data.
 */
const CATALOG = [
  { tag: "qwen3.5:0.8b", sizeGb: 1 },
  { tag: "qwen3.5:2b", sizeGb: 2.7 },
  { tag: "qwen3.5:4b", sizeGb: 3.4 },
  { tag: "qwen3.5:9b", sizeGb: 6.6 },
  { tag: "gemma4:e2b", sizeGb: 7.2, residentGb: 2.5 },
  { tag: "gemma4:e4b", sizeGb: 7.6, residentGb: 5 },
  { tag: "gemma4:12b", sizeGb: 7.6 },
  { tag: "qwen3.5:27b", sizeGb: 17 },
  { tag: "gemma4:26b", sizeGb: 19, moe: true },
  { tag: "gemma4:31b", sizeGb: 20 },
  { tag: "qwen3.5:35b", sizeGb: 24, moe: true },
  { tag: "qwen3.5:122b", sizeGb: 81, moe: true },
];

describe("classifyFit", () => {
  it("rates a small model comfortable on a modest machine", () => {
    // 8 GB host → 5 GB usable → comfortable up to 4 GB required; a 2.7 GB
    // model needs ~3.9 GB and just clears the line.
    expect(classifyFit(dense(2.7), host(8)).tier).toBe("comfortable");
  });

  it("rates a model that fits without headroom as tight", () => {
    // 3.4 GB → ~4.7 GB required, over the 4 GB comfort line but under the
    // 5 GB the machine can actually give it.
    expect(classifyFit(dense(3.4), host(8)).tier).toBe("tight");
  });

  it("rates a model bigger than usable RAM as heavy", () => {
    expect(classifyFit(dense(17), host(8)).tier).toBe("heavy");
    expect(classifyFit(dense(81), host(64)).tier).toBe("heavy");
  });

  it("adds overhead as a floor plus a fraction, not a flat multiplier", () => {
    // 10 GB of weights → 10 × 1.15 + 0.8. The old ×1.2 charged big models
    // for KV cache they don't have (5 GB of phantom need on a 25 GB MoE)
    // while granting sub-1 GB models almost nothing.
    expect(classifyFit(dense(10), host(64)).requiredGb).toBeCloseTo(12.3, 5);
    expect(classifyFit(dense(1), host(64)).requiredGb).toBeCloseTo(1.95, 5);
  });

  it("never calls a model heavy purely because RAM is plentiful", () => {
    expect(classifyFit(dense(24), host(64)).tier).toBe("comfortable");
  });

  it("flags insufficient disk, keeping slack free", () => {
    expect(classifyFit(dense(18), host(32, 19)).insufficientDisk).toBe(true);
    expect(classifyFit(dense(18), host(32, 25)).insufficientDisk).toBe(false);
  });

  it("treats unknown free disk as unknown, never as full", () => {
    expect(classifyFit(dense(81), host(128, null)).insufficientDisk).toBe(false);
  });

  it("survives a host that reports less RAM than the OS reserve", () => {
    const v = classifyFit(dense(1), host(2));
    expect(v.tier).toBe("heavy");
    expect(Number.isFinite(v.requiredGb)).toBe(true);
  });
});

describe("recommendVariant", () => {
  it("picks the largest comfortable variant for the machine", () => {
    expect(recommendVariant(CATALOG, host(8))?.tag).toBe("qwen3.5:2b");
    expect(recommendVariant(CATALOG, host(16))?.tag).toBe("gemma4:12b");
    expect(recommendVariant(CATALOG, host(32))?.tag).toBe("gemma4:26b");
  });

  it("scales its pick up with available RAM, never down", () => {
    const sizeFor = (ramGb: number) =>
      recommendVariant(CATALOG, host(ramGb))!.sizeGb;
    const sizes = [8, 16, 32, 64, 128].map(sizeFor);
    const sorted = [...sizes].sort((a, b) => a - b);
    expect(sizes).toEqual(sorted);
  });

  it("falls back to the smallest variant when nothing is comfortable", () => {
    expect(recommendVariant(CATALOG, host(4))?.tag).toBe("qwen3.5:0.8b");
  });

  it("skips variants that won't fit on disk", () => {
    // Plenty of RAM, but only 12 GB of disk — everything above ~10 GB is out.
    // Among what's left, 12B is the largest *resident* footprint (E4B's
    // matching 7.6 GB download holds only ~5 GB on the accelerator).
    expect(recommendVariant(CATALOG, host(64, 12))?.tag).toBe("gemma4:12b");
  });

  it("recommends the smallest variant when nothing fits on disk", () => {
    // Ample RAM, almost no disk — every variant fails the disk check. The
    // largest-comfortable rule must not apply to a pool the user can't
    // download from: it used to fall back to the whole catalog and still take
    // the biggest comfortable entry, headlining a 24 GB model with its own
    // Pull button disabled by the disk badge.
    const picked = recommendVariant(CATALOG, host(64, 2))!;
    const smallest = [...CATALOG].sort((a, b) => a.sizeGb - b.sizeGb)[0];
    expect(picked.tag).toBe(smallest.tag);
  });

  it("returns null for an empty catalog", () => {
    expect(recommendVariant([], host(16))).toBeNull();
  });
});

describe("rankChatModels", () => {
  const m = (id: string): ModelInfo =>
    ({ id, label: id, provider: "openai" }) as ModelInfo;

  it("moves embedding and audio models behind chat models", () => {
    const ranked = rankChatModels([
      m("text-embedding-3-large"),
      m("whisper-1"),
      m("gpt-4o"),
      m("dall-e-3"),
      m("gpt-4o-mini"),
    ]);
    expect(ranked.map((x) => x.id)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "text-embedding-3-large",
      "whisper-1",
      "dall-e-3",
    ]);
  });

  it("preserves the endpoint's order within each group", () => {
    const ranked = rankChatModels([m("zeta"), m("alpha"), m("mid")]);
    expect(ranked.map((x) => x.id)).toEqual(["zeta", "alpha", "mid"]);
  });

  it("keeps a lone non-chat-looking model rather than emptying the list", () => {
    const ranked = rankChatModels([m("my-embedded-llm")]);
    expect(ranked).toHaveLength(1);
  });
});

describe("classifyFit with a discrete GPU", () => {
  // The bug this whole path exists for: 32 GB of RAM behind an 8 GB card. The
  // RAM-only heuristic called an 18 GB dense model comfortable and recommended
  // it, when in reality most of it would be running on the CPU.
  it("sizes against VRAM, not RAM, when a GPU is present", () => {
    expect(classifyFit(dense(18), host(32)).tier).toBe("comfortable");
    expect(classifyFit(dense(18), gpuHost(32, 8)).tier).toBe("offload");
  });

  it("calls a model that overflows VRAM but fits RAM an offload, not heavy", () => {
    // Runs — just with layers on the CPU — so it must not read as impossible.
    expect(classifyFit(dense(12), gpuHost(64, 8)).tier).toBe("offload");
  });

  it("still calls a model heavy when its weights exceed RAM as well", () => {
    expect(classifyFit(dense(81), gpuHost(16, 8)).tier).toBe("heavy");
  });

  it("never reports offload without a GPU — there is nothing to spill from", () => {
    const tiers = [1, 8, 18, 81].map((gb) => classifyFit(dense(gb), host(16)).tier);
    expect(tiers).not.toContain("offload");
  });

  it("lets a large GPU rate a model comfortable that RAM alone would reject", () => {
    // 16 GB of system RAM can't hold a 12 GB model (needs ~14.6 GB), but a
    // 24 GB card runs it entirely on the GPU — the under-recommendation case.
    expect(classifyFit(dense(12), host(16)).tier).toBe("heavy");
    expect(classifyFit(dense(12), gpuHost(16, 24)).tier).toBe("comfortable");
  });
});

describe("recommendVariant with a discrete GPU", () => {
  it("recommends what fits the card, not what fits system RAM", () => {
    expect(recommendVariant(CATALOG, host(32))?.tag).toBe("gemma4:26b");
    expect(recommendVariant(CATALOG, gpuHost(32, 8))?.tag).toBe("qwen3.5:4b");
  });

  it("scales its pick with VRAM at fixed RAM", () => {
    const sizeFor = (vramGb: number) =>
      recommendVariant(CATALOG, gpuHost(64, vramGb))!.sizeGb;
    const sizes = [8, 12, 24, 48].map(sizeFor);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });
});

describe("E-variants: resident footprint vs download size", () => {
  // Regression: `gemma4:e2b` downloads 7.2 GB but holds only ~2.5 GB on the
  // accelerator (per-layer embeddings stay in system RAM). Judging it by
  // download size declared an edge-device model unusable on the 8 GB card it
  // is designed for — while `qwen3.5:4b`, the same effective class, passed
  // simply because it ships a smaller file.
  const e2b = { tag: "gemma4:e2b", sizeGb: 7.2, residentGb: 2.5 };
  const qwen4b = { tag: "qwen3.5:4b", sizeGb: 3.4 };
  const rtx4060 = gpuHost(32, 7.77);

  it("judges memory fit on the resident size, not the download", () => {
    expect(classifyFit(dense(e2b.sizeGb), rtx4060).tier).toBe("offload");
    expect(classifyFit(e2b, rtx4060).tier).toBe("comfortable");
  });

  it("puts two models of the same effective class in the same tier", () => {
    expect(classifyFit(e2b, rtx4060).tier).toBe(
      classifyFit(qwen4b, rtx4060).tier,
    );
  });

  it("still checks disk against the real download, not the resident size", () => {
    // 7.2 GB to fetch with 8 GB free: fits memory, not the volume.
    const tightDisk = { ...rtx4060, freeDiskBytes: 8 * GB };
    expect(classifyFit(e2b, tightDisk).insufficientDisk).toBe(true);
  });

  it("ranks by resident size, not by download size", () => {
    // Both are comfortable here. Ranked by download, E2B's 7.2 GB would win;
    // ranked by what actually occupies the card, qwen3.5:4b (3.4 GB resident
    // vs E2B's ~2.5) is the bigger model and the better pick.
    expect(recommendVariant([qwen4b, e2b], rtx4060)?.tag).toBe("qwen3.5:4b");
  });

  it("judges ordinary models by their download unchanged", () => {
    expect(classifyFit(dense(6.6), rtx4060).tier).toBe(
      classifyFit({ sizeGb: 6.6, residentGb: 6.6 }, rtx4060).tier,
    );
  });
});

describe("MoE models split across GPU and RAM", () => {
  // Regression: a 30B-A3B MoE (25 GB download) on 32 GB RAM behind an 8 GB
  // card is the hardware it's marketed for — only ~3B parameters are touched
  // per token, so the GPU/RAM split stays fast. The old flat ×1.2 overhead
  // (30 GB "required" vs 29 GB usable RAM) filed it as heavy: "needs more
  // memory than the machine has at all". Weights-fit-RAM is the honest bound.
  const rtx4060 = gpuHost(32, 7.77);
  const nemotron = { sizeGb: 25, moe: true };

  it("files a MoE whose weights fit RAM as offload, never heavy", () => {
    const v = classifyFit(nemotron, rtx4060);
    expect(v.tier).toBe("offload");
    expect(v.moeSplit).toBe(true);
    expect(classifyFit({ sizeGb: 24, moe: true }, rtx4060).moeSplit).toBe(true);
  });

  it("does not flag a dense model's offload as a MoE split", () => {
    const v = classifyFit(dense(18), rtx4060);
    expect(v.tier).toBe("offload");
    expect(v.moeSplit).toBe(false);
  });

  it("keeps a MoE heavy when even RAM can't hold the weights", () => {
    const v = classifyFit({ sizeGb: 81, moe: true }, gpuHost(16, 8));
    expect(v.tier).toBe("heavy");
    expect(v.moeSplit).toBe(false);
  });

  it("doesn't mark a split when the MoE fits the card outright", () => {
    const v = classifyFit({ sizeGb: 19, moe: true }, gpuHost(64, 48));
    expect(v.tier).toBe("comfortable");
    expect(v.moeSplit).toBe(false);
  });

  it("sizes a MoE by RAM like anything else when there is no GPU", () => {
    // No GPU → no split to report; all 19 GB of weights count against RAM.
    const v = classifyFit({ sizeGb: 19, moe: true }, host(32));
    expect(v.tier).toBe("comfortable");
    expect(v.moeSplit).toBe(false);
  });
});

describe("capacityBasis", () => {
  it("names VRAM when a GPU is present and RAM otherwise", () => {
    expect(capacityBasis(gpuHost(32, 8))).toEqual({ kind: "vram", totalGb: 8 });
    expect(capacityBasis(host(32))).toEqual({ kind: "ram", totalGb: 32 });
  });
});

describe("formatGb", () => {
  it("keeps a decimal under 10 GB and rounds above it", () => {
    expect(formatGb(3.4)).toBe("3.4 GB");
    expect(formatGb(18.2)).toBe("18 GB");
  });
});
