// The Modelfile builder is an injection surface: its output is POSTed to
// Ollama's /api/create, whose parser ends triple-quoted blocks on the first
// literal `"""` (no escape syntax) and treats every line start as a
// potential directive. These tests pin the hardening — tag allowlist, `"""`
// refusal — and the stop-parameter escape/unescape symmetry between
// `buildModelfile` and `parseParamsBlock` (which reads /api/show output).

import { describe, it, expect } from "vitest";
import { buildModelfile, parseParamsBlock } from "./modelfile";
import type { ModelfileForm } from "@/types";

const form = (over: Partial<ModelfileForm> = {}): ModelfileForm => ({
  name: "my-model:v1",
  from: "llama3.1:8b",
  system: "",
  template: "",
  params: { stop: [] },
  ...over,
});

describe("buildModelfile", () => {
  it("emits a minimal FROM-only Modelfile with trailing newline", () => {
    expect(buildModelfile(form())).toBe("FROM llama3.1:8b\n");
  });

  it("wraps SYSTEM and TEMPLATE in triple quotes", () => {
    const out = buildModelfile(
      form({ system: "You are terse.\nVery terse.", template: "<|user|>{{ .Prompt }}" }),
    );
    expect(out).toContain('SYSTEM """You are terse.\nVery terse."""');
    expect(out).toContain('TEMPLATE """<|user|>{{ .Prompt }}"""');
  });

  it("accepts realistic model tags", () => {
    for (const tag of [
      "llama3.1:8b-instruct-q4_K_M",
      "library/qwen2.5:7b",
      "gemma3",
      "x_y-z.0",
    ]) {
      expect(() => buildModelfile(form({ from: tag }))).not.toThrow();
    }
  });

  it("rejects tags that could smuggle directives or shell metacharacters", () => {
    for (const tag of [
      "", // FROM is required
      "llama 3.1", // whitespace
      "llama\nFROM evil", // newline = second directive
      "a;b",
      "a/b/c", // at most one registry path segment
      "a:b:c", // at most one tag separator
      "x".repeat(256), // length cap
    ]) {
      expect(() => buildModelfile(form({ from: tag })), tag).toThrow();
    }
  });

  it('rejects SYSTEM / TEMPLATE bodies containing a literal """', () => {
    expect(() => buildModelfile(form({ system: 'end""" FROM evil' }))).toThrow(/SYSTEM/);
    expect(() => buildModelfile(form({ template: 'x"""y' }))).toThrow(/TEMPLATE/);
  });

  it("emits only finite, non-null parameters", () => {
    const out = buildModelfile(
      form({
        params: {
          temperature: 0.7,
          top_p: null,
          top_k: undefined,
          num_ctx: NaN,
          seed: Infinity,
          stop: [],
        },
      }),
    );
    expect(out).toContain("PARAMETER temperature 0.7");
    expect(out).not.toMatch(/top_p|top_k|num_ctx|seed/);
  });

  it("skips blank stop entries and trims the rest", () => {
    const out = buildModelfile(form({ params: { stop: ["  <|end|> ", "   ", ""] } }));
    expect(out).toContain('PARAMETER stop "<|end|>"');
    expect(out.match(/PARAMETER stop/g)).toHaveLength(1);
  });

  it("escape round-trips stop strings through parseParamsBlock", () => {
    // The builder escapes `\` and `"` for the quoted PARAMETER form;
    // `parseParamsBlock` (reading the same quoted form back out of
    // /api/show) must invert it exactly — including the nasty
    // backslash-before-quote case where unescape order matters.
    const originals = ['he"llo\\', 'a\\"', "plain", "tab\\there"];
    const built = buildModelfile(form({ params: { stop: originals } }));
    const showBlock = built
      .split("\n")
      .filter((l) => l.startsWith("PARAMETER stop "))
      .map((l) => l.replace(/^PARAMETER /, ""))
      .join("\n");
    expect(parseParamsBlock(showBlock).stop).toEqual(originals);
  });
});

describe("parseParamsBlock", () => {
  it("returns an empty form for null / undefined / empty input", () => {
    expect(parseParamsBlock(null)).toEqual({ stop: [] });
    expect(parseParamsBlock(undefined)).toEqual({ stop: [] });
    expect(parseParamsBlock("")).toEqual({ stop: [] });
  });

  it("parses known numeric keys and accumulates stop entries", () => {
    const p = parseParamsBlock(
      'temperature 0.6\ntop_p 0.9\nstop "<|end|>"\nstop "<|eot|>"',
    );
    expect(p.temperature).toBe(0.6);
    expect(p.top_p).toBe(0.9);
    expect(p.stop).toEqual(["<|end|>", "<|eot|>"]);
  });

  it("skips comments, unknown keys, and malformed lines without throwing", () => {
    const p = parseParamsBlock(
      "# a comment\nnot_a_real_key 42\nnovaluehere\ntemperature notanumber\ntop_k 40",
    );
    expect(p.top_k).toBe(40);
    expect(p.temperature).toBeUndefined();
    expect((p as Record<string, unknown>)["not_a_real_key"]).toBeUndefined();
  });

  it("strips single or double quotes from stop values", () => {
    const p = parseParamsBlock("stop \"<|a|>\"\nstop '<|b|>'\nstop <|c|>");
    expect(p.stop).toEqual(["<|a|>", "<|b|>", "<|c|>"]);
  });
});
