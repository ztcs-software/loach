// Read aloud speaks `speechChunks`, so markup that survives here is what the
// voice says out loud ("asterisk asterisk", "pipe").

import { describe, it, expect } from "vitest";
import { speechChunks } from "./speech";

describe("speechChunks", () => {
  it("strips block and inline markup, one chunk per block", () => {
    const md = [
      "## Setup",
      "",
      "Install **Ollama** and _then_ read [the docs](https://example.com).",
      "It takes a `minute`.",
      "",
      "- [x] first item",
      "  still the first",
      "* second",
      "1. Step one",
      "",
      "> Quoted ~~text~~",
      "",
      "---",
    ].join("\n");
    expect(speechChunks(md)).toEqual([
      "Setup",
      "Install Ollama and then read the docs. It takes a minute.",
      "first item still the first",
      "second",
      "1. Step one",
      "Quoted text",
    ]);
  });

  it("skips code blocks and display math but keeps inline math", () => {
    const md = [
      "Before.",
      "```js",
      "const a = 1;",
      "```",
      "1. ```bash",
      "   echo hi",
      "   ```",
      "$$",
      "E = mc^2",
      "$$",
      "Where \\(\\alpha\\) is small, and it costs $5 and $10.",
    ].join("\n");
    expect(speechChunks(md)).toEqual([
      "Before.",
      "Where alpha is small, and it costs $5 and $10.",
    ]);
  });

  it("reads table rows as comma-separated cells", () => {
    const md = "| Model | Size |\n|:---|---:|\n| **llama** | 8 GB |";
    expect(speechChunks(md)).toEqual(["Model, Size", "llama, 8 GB"]);
  });

  it("reads inline code as written", () => {
    expect(speechChunks("Use `Vec<String>` or **`**kwargs`** in `C:\\Users`, not <b>this</b>.")).toEqual([
      "Use Vec<String> or **kwargs in C:\\Users, not this .",
    ]);
  });

  // An online voice ends an utterance after ~15 s with no `end` event.
  it("speaks a long paragraph a few sentences at a time", () => {
    const sentence = "This sentence is here to make the paragraph long enough to split.";
    const paragraph = Array.from({ length: 8 }, () => sentence).join(" ");
    const chunks = speechChunks(paragraph);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join(" ")).toBe(paragraph);

    const runOn = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const pieces = speechChunks(runOn);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).toBe(runOn);
  });

  it("keeps underscores inside words", () => {
    expect(speechChunks("Set my_var to __init__.")).toEqual(["Set my_var to init."]);
  });

  it("has nothing to say for a code-only reply", () => {
    expect(speechChunks("```py\nprint(1)\n```")).toEqual([]);
  });
});
