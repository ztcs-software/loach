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

/**
 * Representative variant sizes spanning the shipped catalog's range, smallest
 * to largest. Deliberately a *sample* rather than a mirror of OLLAMA_CATALOG:
 * these tests pin the sizing math, so binding them to the live catalog would
 * break every expectation below each time a family is added or dropped. Tags
 * are real ones so a failure names something recognisable.
 */
const CATALOG = [
  { tag: "qwen3.5:0.8b", sizeGb: 1 },
  { tag: "qwen3.5:2b", sizeGb: 2.7 },
  { tag: "qwen3.5:4b", sizeGb: 3.4 },
  { tag: "qwen3.5:9b", sizeGb: 6.6 },
  { tag: "gemma4:e2b", sizeGb: 7.2 },
  { tag: "gemma4:12b", sizeGb: 7.6 },
  { tag: "gemma4:e4b", sizeGb: 9.6 },
  { tag: "qwen3.5:27b", sizeGb: 17 },
  { tag: "gemma4:26b", sizeGb: 18 },
  { tag: "gemma4:31b", sizeGb: 20 },
  { tag: "qwen3.5:35b", sizeGb: 24 },
  { tag: "qwen3.5:122b", sizeGb: 81 },
];

describe("classifyFit", () => {
  it("rates a small model comfortable on a modest machine", () => {
    // 8 GB host → 5 GB usable → comfortable up to 4 GB required (3.33 on disk).
    expect(classifyFit(2.7, host(8)).tier).toBe("comfortable");
  });

  it("rates a model that fits without headroom as tight", () => {
    // 3.4 GB → 4.08 GB required, over the 4 GB comfort line but under the
    // 5 GB the machine can actually give it.
    expect(classifyFit(3.4, host(8)).tier).toBe("tight");
  });

  it("rates a model bigger than usable RAM as heavy", () => {
    expect(classifyFit(17, host(8)).tier).toBe("heavy");
    expect(classifyFit(81, host(64)).tier).toBe("heavy");
  });

  it("reports the estimated requirement, not the raw file size", () => {
    expect(classifyFit(10, host(64)).requiredGb).toBeCloseTo(12, 5);
  });

  it("never calls a model heavy purely because RAM is plentiful", () => {
    expect(classifyFit(24, host(64)).tier).toBe("comfortable");
  });

  it("flags insufficient disk, keeping slack free", () => {
    expect(classifyFit(18, host(32, 19)).insufficientDisk).toBe(true);
    expect(classifyFit(18, host(32, 25)).insufficientDisk).toBe(false);
  });

  it("treats unknown free disk as unknown, never as full", () => {
    expect(classifyFit(81, host(128, null)).insufficientDisk).toBe(false);
  });

  it("survives a host that reports less RAM than the OS reserve", () => {
    const v = classifyFit(1, host(2));
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
    expect(recommendVariant(CATALOG, host(64, 12))?.tag).toBe("gemma4:e4b");
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
  // RAM-only heuristic called an 18 GB model comfortable and recommended it,
  // when in reality most of it would be running on the CPU.
  it("sizes against VRAM, not RAM, when a GPU is present", () => {
    expect(classifyFit(18, host(32)).tier).toBe("comfortable");
    expect(classifyFit(18, gpuHost(32, 8)).tier).toBe("offload");
  });

  it("calls a model that overflows VRAM but fits RAM an offload, not heavy", () => {
    // Runs — just with layers on the CPU — so it must not read as impossible.
    expect(classifyFit(12, gpuHost(64, 8)).tier).toBe("offload");
  });

  it("still calls a model heavy when it exceeds RAM as well", () => {
    expect(classifyFit(81, gpuHost(16, 8)).tier).toBe("heavy");
  });

  it("never reports offload without a GPU — there is nothing to spill from", () => {
    const tiers = [1, 8, 18, 81].map((gb) => classifyFit(gb, host(16)).tier);
    expect(tiers).not.toContain("offload");
  });

  it("lets a large GPU rate a model comfortable that RAM alone would reject", () => {
    // 16 GB of system RAM can't hold a 12 GB model (needs ~14.4 GB), but a
    // 24 GB card runs it entirely on the GPU — the under-recommendation case.
    expect(classifyFit(12, host(16)).tier).toBe("heavy");
    expect(classifyFit(12, gpuHost(16, 24)).tier).toBe("comfortable");
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
