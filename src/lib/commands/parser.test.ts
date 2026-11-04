// Palette completion for command arguments.
//
// Names that live in app state (models, Spaces, snippets) arrive as
// `argSources`; a command whose argument is optional keeps its bare form
// reachable, or Enter on `/model` would complete the first model instead of
// opening the picker.

import { describe, it, expect } from "vitest";
import { matchCommands, modelArgValues } from "./parser";

const sources = {
  model: ["llama3:70b", "llama3", "qwen3:8b"],
  space: ["Work", "Home"],
};

const inserts = (query: string) =>
  matchCommands(query, sources).map((e) => e.insertText);

describe("argument completion", () => {
  it("completes state-backed names, putting an exact match first", () => {
    expect(inserts("model llama3")).toEqual(["/model llama3", "/model llama3:70b"]);
  });

  it("matches anywhere in a name, ignoring case", () => {
    expect(inserts("model 8B")).toEqual(["/model qwen3:8b"]);
  });

  it("lists nothing once the typed value matches no name", () => {
    expect(inserts("model mistral")).toEqual([]);
  });

  it("heads an optional argument's list with the bare command", () => {
    const entries = matchCommands("model", sources);
    // insertText equals the typed text, so Enter runs it rather than
    // completing the row.
    expect(entries[0]).toMatchObject({ sub: null, insertText: "/model" });
    expect(entries.slice(1).map((e) => e.sub)).toEqual(["llama3:70b", "llama3", "qwen3:8b"]);
    expect(inserts("instructions")).toEqual(["/instructions", "/instructions clear"]);
  });

  it("offers no bare row when the argument is required", () => {
    expect(inserts("space")).toEqual(["/space Work", "/space Home"]);
  });

  it("completes an optional-argument name without a trailing space", () => {
    expect(inserts("mode")).toEqual(["/model"]);
    expect(inserts("spac")).toEqual(["/space "]);
  });

  it("falls back to the bare command when there are no names to offer", () => {
    expect(matchCommands("model").map((e) => e.insertText)).toEqual(["/model"]);
  });

  // They take on|off, and Enter on `/thinking ` used to run a usage error
  // because there was nothing to complete.
  it("offers on and off for the toggles", () => {
    expect(inserts("thinking ")).toEqual(["/thinking on", "/thinking off"]);
    expect(inserts("web-fetch o")).toEqual(["/web-fetch on", "/web-fetch off"]);
    expect(inserts("thin")).toEqual(["/thinking "]);
  });
});

describe("modelArgValues", () => {
  it("prefixes an id both providers serve, and only that one", () => {
    expect(
      modelArgValues([
        { id: "llama3", provider: "ollama" },
        { id: "qwen3:8b", provider: "ollama" },
        { id: "llama3", provider: "openai" },
        { id: "gpt-4o", provider: "openai" },
      ]),
    ).toEqual(["ollama/llama3", "qwen3:8b", "openai/llama3", "gpt-4o"]);
  });

  it("completes the two as separate rows", () => {
    const model = modelArgValues([
      { id: "llama3", provider: "ollama" },
      { id: "llama3", provider: "openai" },
    ]);
    expect(matchCommands("model llama3", { model }).map((e) => e.insertText)).toEqual([
      "/model ollama/llama3",
      "/model openai/llama3",
    ]);
  });
});

describe("text that only starts with a slash", () => {
  // `matchCommands` gets the composer text minus its first `/`. A pasted code
  // comment or an aside used to open the palette with every command, and
  // Enter then replaced the whole draft with the first one.
  it("lists nothing for `//` or `/ ` prose", () => {
    expect(matchCommands("/ why does this fail?\nconst x = 1;")).toEqual([]);
    expect(matchCommands("/")).toEqual([]);
    expect(matchCommands(" aside")).toEqual([]);
  });

  it("still lists every command for a bare slash", () => {
    expect(matchCommands("").length).toBeGreaterThan(10);
  });
});
