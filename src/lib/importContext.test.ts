// `parseImportContext` takes arbitrary pasted text through an
// order-dependent format detector (JSON → Markdown → plain). The traps these
// tests pin: prose that merely LOOKS like a format must fall through to the
// next detector (not error, not vanish), role normalisation must match what
// the chat-history builder can actually send (system/developer → user), and
// the 4 MiB JSON cap must reroute rather than freeze the renderer.

import { describe, it, expect } from "vitest";
import { parseImportContext } from "./importContext";

describe("parseImportContext — JSON branch", () => {
  it("parses an exported-session shape and normalises roles", () => {
    const json = JSON.stringify({
      session: { id: "s1" },
      messages: [
        { role: "You", content: "hi" },
        { role: "AI", content: "hello" },
        { role: "model", content: "also assistant" },
        { role: "developer", content: "be terse" },
        { role: "system", content: "system prompt" },
        { role: "tool", content: "dropped — unmappable role" },
      ],
    });
    const out = parseImportContext(json);
    expect(out.format).toBe("json");
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "also assistant" },
      // system/developer become USER turns — role:"system" rows never reach
      // the model (the system prompt travels in a dedicated field), so
      // keeping them as system would silently break the import's promise.
      { role: "user", content: "be terse" },
      { role: "user", content: "system prompt" },
    ]);
  });

  it("accepts a bare messages array and a bare single message object", () => {
    expect(parseImportContext('[{"role":"user","content":"x"}]').format).toBe("json");
    const single = parseImportContext('{"role":"assistant","content":"y"}');
    expect(single.format).toBe("json");
    expect(single.messages).toEqual([{ role: "assistant", content: "y" }]);
  });

  it("stitches OpenAI-style content block arrays into one string", () => {
    const json = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "data:..." } },
            "second",
            { text: "third" },
          ],
        },
      ],
    });
    expect(parseImportContext(json).messages).toEqual([
      { role: "user", content: "first\n\nsecond\n\nthird" },
    ]);
  });

  it("drops messages with empty content, and falls through when nothing usable remains", () => {
    // Valid JSON, zero usable messages → NOT format:"json"; the text drops
    // to the plain branch so the user still gets an import.
    const out = parseImportContext('{"messages":[{"role":"user","content":"  "}]}');
    expect(out.format).toBe("plain");
  });

  it("falls through to plain text on malformed JSON that merely starts with {", () => {
    const out = parseImportContext("{ this is just prose with a brace");
    expect(out.format).toBe("plain");
    expect(out.messages).toEqual([
      { role: "user", content: "{ this is just prose with a brace" },
    ]);
  });

  it("skips the JSON parse entirely above the 4 MiB cap", () => {
    // Would be valid JSON, but parsing multi-MB synchronously can freeze the
    // renderer — the cap reroutes to the plain branch instead.
    const huge = `["${"a".repeat(4 * 1024 * 1024)}"]`;
    expect(parseImportContext(huge).format).toBe("plain");
  });
});

describe("parseImportContext — Markdown branch", () => {
  it("splits on exported ## You / ## Assistant / ## System headers", () => {
    const md = [
      "## You",
      "first question",
      "",
      "## Assistant",
      "the answer",
      "",
      "## System",
      "imported instructions",
    ].join("\n");
    const out = parseImportContext(md);
    expect(out.format).toBe("markdown");
    expect(out.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "the answer" },
      { role: "user", content: "imported instructions" }, // System → user
    ]);
  });

  it("requires the header to be the whole line", () => {
    // "## Assistant said:" must NOT route into the markdown branch — the
    // detector and section parser share anchoring, so header-ish prose
    // lands in plain text instead of importing as zero messages.
    const out = parseImportContext("## Assistant said:\nsome quote");
    expect(out.format).toBe("plain");
  });

  it("drops sections whose body is empty", () => {
    const out = parseImportContext("## You\n\n## Assistant\nreply");
    expect(out.messages).toEqual([{ role: "assistant", content: "reply" }]);
  });
});

describe("parseImportContext — plain and empty", () => {
  it("returns empty for blank input", () => {
    expect(parseImportContext("")).toEqual({ format: "empty", messages: [] });
    expect(parseImportContext("   \n  ")).toEqual({ format: "empty", messages: [] });
  });

  it("wraps anything else as a single trimmed user message", () => {
    const out = parseImportContext("  just an article body  ");
    expect(out).toEqual({
      format: "plain",
      messages: [{ role: "user", content: "just an article body" }],
    });
  });
});
