// Regression coverage for snippet variable expansion (finding H16).
//
// The old code used a single global `expanded` set, so a variable used more
// than once expanded only at its first occurrence — later occurrences survived
// as literal `{{KEY}}` and were then wrongly reported unresolved (the fill
// dialog would ask for a variable that already had a value). Expansion now
// tracks the per-path chain of keys, so every occurrence expands while cycles
// and self-reference still terminate.

import { describe, it, expect } from "vitest";
import { applyFillValues, expandKnownVars } from "./snippetVars";

const NOW = new Date("2026-06-10T12:00:00Z");
// Minimal SnippetVariable shape — only key/value are read here.
const g = (key: string, value: string) => ({ key, value }) as never;

describe("expandKnownVars", () => {
  it("expands a built-in used multiple times at EVERY occurrence (H16)", () => {
    const r = expandKnownVars(
      "Hi {{USER_NAME}}, bye {{USER_NAME}}",
      [],
      "Ada",
      NOW,
    );
    expect(r.resolved).toBe("Hi Ada, bye Ada");
    expect(r.unresolved).toEqual([]);
  });

  it("expands a custom global used multiple times", () => {
    const r = expandKnownVars("{{TEAM}} / {{TEAM}}", [g("TEAM", "Infra")], "", NOW);
    expect(r.resolved).toBe("Infra / Infra");
    expect(r.unresolved).toEqual([]);
  });

  it("expands placeholders nested inside a value", () => {
    const r = expandKnownVars(
      "{{GREETING}}",
      [g("GREETING", "Hello {{USER_NAME}}")],
      "Ada",
      NOW,
    );
    expect(r.resolved).toBe("Hello Ada");
    expect(r.unresolved).toEqual([]);
  });

  it("reports an unknown key as unresolved and leaves it literal", () => {
    const r = expandKnownVars("Fill {{MISSING}} here", [], "Ada", NOW);
    expect(r.resolved).toBe("Fill {{MISSING}} here");
    expect(r.unresolved).toEqual(["MISSING"]);
  });

  it("substitutes an explicitly-empty global to nothing (not unresolved)", () => {
    const r = expandKnownVars("[{{NOTE}}]", [g("NOTE", "")], "Ada", NOW);
    expect(r.resolved).toBe("[]");
    expect(r.unresolved).toEqual([]);
  });

  it("terminates on self-reference, leaving the placeholder unresolved", () => {
    const r = expandKnownVars("{{FOO}}", [g("FOO", "{{FOO}}")], "Ada", NOW);
    expect(r.resolved).toBe("{{FOO}}");
    expect(r.unresolved).toEqual(["FOO"]);
  });

  it("terminates on a cycle without blowing up", () => {
    const r = expandKnownVars(
      "{{A}}",
      [g("A", "{{B}}"), g("B", "{{A}}")],
      "Ada",
      NOW,
    );
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.resolved).toMatch(/\{\{[AB]\}\}/);
  });

  it("does not blow up on a self-multiplying value", () => {
    const r = expandKnownVars("{{X}}", [g("X", "{{X}} {{X}}")], "Ada", NOW);
    expect(r.resolved).toBe("{{X}} {{X}}");
    expect(r.unresolved).toEqual(["X"]);
  });

  it("caps runaway expansion from chained self-multiplying globals", () => {
    // V1..V30 each double the previous WITHOUT revisiting a key on any one
    // path, so the per-path cycle guard never fires — uncapped, expanding
    // {{V30}} composes 2^30 characters and freezes the renderer. The budget
    // must stop substitution, leaving the overflow literal (which then
    // routes to the fill dialog instead of hanging the app).
    const globals = [g("V0", "x")];
    for (let i = 1; i <= 30; i++) {
      globals.push(g(`V${i}`, `{{V${i - 1}}}{{V${i - 1}}}`));
    }
    const r = expandKnownVars("{{V30}}", globals, "Ada", NOW);
    // 64 KiB budget + at most one value of overshoot.
    expect(r.resolved.length).toBeLessThan(80 * 1024);
  });

  it("tolerates whitespace inside the braces", () => {
    const r = expandKnownVars("Hi {{ USER_NAME }}", [], "Ada", NOW);
    expect(r.resolved).toBe("Hi Ada");
  });

  it("reports unresolved keys deduplicated in first-appearance order", () => {
    // The fill dialog renders one input per key, top-down in prompt order.
    const r = expandKnownVars("{{ZED}} then {{ALPHA}} then {{ZED}}", [], "Ada", NOW);
    expect(r.unresolved).toEqual(["ZED", "ALPHA"]);
  });

  it("does not let a custom global shadow a built-in", () => {
    // Server-side validation already rejects reserved keys; this pins the
    // client-side defense in depth (built-ins enter the table first).
    const r = expandKnownVars("{{USER_NAME}}", [g("USER_NAME", "EVIL")], "Ada", NOW);
    expect(r.resolved).toBe("Ada");
  });

  it("ignores text that only looks like a placeholder", () => {
    // The regex is intentionally narrow (uppercase identifier) so prose and
    // code like `{{foo}}` or `{ x }` is neither expanded nor flagged.
    const prompt = "code {{foo}} and { X } and {{TWO WORDS}} stay literal";
    const r = expandKnownVars(prompt, [], "Ada", NOW);
    expect(r.resolved).toBe(prompt);
    expect(r.unresolved).toEqual([]);
  });
});

describe("applyFillValues", () => {
  it("applies provided fills and leaves missing keys literal", () => {
    // Missing keys surviving as `{{KEY}}` is the safety net for a bypassed
    // fill dialog — the model sees the placeholder, not silent emptiness.
    const out = applyFillValues("dear {{ NAME }}, re: {{SUBJECT}}", { NAME: "Ada" });
    expect(out).toBe("dear Ada, re: {{SUBJECT}}");
  });

  it("substitutes empty-string fills rather than skipping them", () => {
    expect(applyFillValues("a{{GAP}}b", { GAP: "" })).toBe("ab");
  });
});
