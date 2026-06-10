// `computeContextUsage` detects inlined attachment blocks with regexes that
// must mirror the exact header/footer `inlineTextAttachments` (files.ts)
// emits. The two once drifted silently — the old pattern expected a header
// the inliner never produced, so the attachment row in the context popup
// was always 0. The contract test below builds the content with the REAL
// inliner so any future format change breaks loudly here.

import { describe, it, expect } from "vitest";
import {
  computeContextUsage,
  estimateTokens,
  extractSummary,
  formatTokens,
  stripSummaryBlock,
  SUMMARY_END_TAG,
  SUMMARY_START_TAG,
} from "./contextUsage";
import { inlineTextAttachments } from "./files";
import type { Attachment, GenerationParams, Message } from "@/types";

const msg = (
  role: Message["role"],
  content: string,
  extra: Partial<Message> = {},
): Message =>
  ({
    id: "m1",
    session_id: "s1",
    role,
    content,
    thinking: null,
    attachments_json: null,
    metrics_json: null,
    tool_calls_json: null,
    compacted_at: null,
    ...extra,
  }) as Message;

const att = (over: Partial<Attachment> = {}): Attachment => ({
  kind: "text",
  name: "notes.txt",
  mime: "text/plain",
  data: "alpha beta gamma ".repeat(40),
  ...over,
});

const NO_PARAMS = {} as GenerationParams;

describe("computeContextUsage — attachment detection contract", () => {
  it("counts blocks emitted by the real inlineTextAttachments", () => {
    const base = "Please review this file.";
    const content = inlineTextAttachments(base, [att()]);
    const usage = computeContextUsage([msg("user", content)], null, NO_PARAMS);

    // Everything the inliner appended must be attributed to attachments.
    const appendedChars = content.length - base.length;
    expect(appendedChars).toBeGreaterThan(0);
    expect(usage.attachmentsTokens).toBe(Math.ceil(appendedChars / 4));
  });

  it("recognises the PDF and Word label variants", () => {
    for (const mime of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      const content = inlineTextAttachments("x", [att({ mime, name: "doc" })]);
      const usage = computeContextUsage([msg("user", content)], null, NO_PARAMS);
      expect(usage.attachmentsTokens, mime).toBeGreaterThan(0);
    }
  });

  it("attributes nothing when there is no attachment block", () => {
    const usage = computeContextUsage([msg("user", "plain question")], null, NO_PARAMS);
    expect(usage.attachmentsTokens).toBe(0);
  });
});

describe("computeContextUsage — what reaches the model", () => {
  it("skips system rows and compacted rows, mirroring chatHistory()", () => {
    const messages = [
      msg("system", "x".repeat(400)),
      msg("user", "old turn".repeat(50), { compacted_at: 123 }),
      msg("user", "abcd"), // 4 chars → 1 token
    ];
    const usage = computeContextUsage(messages, "12345678", NO_PARAMS);
    expect(usage.messageCount).toBe(1);
    expect(usage.messagesTokens).toBe(1);
    expect(usage.systemPromptTokens).toBe(2);
    expect(usage.used).toBe(3);
  });

  it("counts thinking text toward the estimate", () => {
    const usage = computeContextUsage(
      [msg("assistant", "abcd", { thinking: "abcd" })],
      null,
      NO_PARAMS,
    );
    expect(usage.messagesTokens).toBe(2);
  });

  it("falls back to 8192 ctx when num_ctx is absent or nonsense, and clamps ratio", () => {
    const big = msg("user", "x".repeat(8192 * 4 * 2)); // 2× the fallback window
    expect(computeContextUsage([big], null, NO_PARAMS).total).toBe(8192);
    expect(computeContextUsage([big], null, { num_ctx: 0 } as GenerationParams).total).toBe(8192);
    expect(computeContextUsage([big], null, NO_PARAMS).ratio).toBe(1);
    expect(
      computeContextUsage([big], null, { num_ctx: 2048 } as GenerationParams).total,
    ).toBe(2048);
  });
});

describe("summary block markers", () => {
  const prompt = `${SUMMARY_START_TAG}\n- earlier stuff\n${SUMMARY_END_TAG}\n\nBe terse.`;

  it("extractSummary returns the inner text, or null when absent", () => {
    expect(extractSummary(prompt)).toBe("- earlier stuff");
    expect(extractSummary("no block here")).toBeNull();
    expect(extractSummary(null)).toBeNull();
  });

  it("stripSummaryBlock removes the block and survives re-compaction", () => {
    const stripped = stripSummaryBlock(prompt);
    expect(stripped).toBe("Be terse.");
    // Idempotent — stripping again changes nothing (re-compaction path).
    expect(stripSummaryBlock(stripped)).toBe("Be terse.");
    expect(stripSummaryBlock(null)).toBe("");
  });
});

describe("token formatting", () => {
  it("estimateTokens is ceil(chars / 4) with null tolerance", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("formatTokens buckets: raw, one-decimal k, rounded k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2000)).toBe("2k"); // trailing .0 dropped
    expect(formatTokens(12345)).toBe("12k");
  });
});
