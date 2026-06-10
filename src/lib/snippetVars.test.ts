// Regression coverage for snippet variable expansion (finding H16).
//
// The old code used a single global `expanded` set, so a variable used more
// than once expanded only at its first occurrence — later occurrences survived
// as literal `{{KEY}}` and were then wrongly reported unresolved (the fill
// dialog would ask for a variable that already had a value). Expansion now
// tracks the per-path chain of keys, so every occurrence expands while cycles
// and self-reference still terminate.

import { describe, it, expect } from "vitest";
import { expandKnownVars } from "./snippetVars";

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
});
