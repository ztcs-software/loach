import { describe, it, expect } from "vitest";
import {
  buildExtractorSystemPrompt,
  isDuplicate,
  normalize,
  parseExtractionJson,
  selectMemoriesForPrompt,
} from "./memoryRules";

describe("normalize", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalize("  User likes   TypeScript.  ")).toBe("user likes typescript");
    expect(normalize("Lives in Warsaw, Poland!")).toBe("lives in warsaw poland");
  });
});

describe("isDuplicate", () => {
  const existing = [
    "prefers typescript over javascript",
    "user lives in warsaw poland",
    "works on a tauri desktop app called loach",
  ];

  it("flags exact and phrasing-only duplicates", () => {
    expect(isDuplicate("prefers typescript over javascript", existing)).toBe(true);
    // Strict token containment of a 3+ word candidate.
    expect(isDuplicate("lives in warsaw", existing)).toBe(true);
    // High Jaccard overlap.
    expect(isDuplicate("user lives in warsaw", existing)).toBe(true);
  });

  it("does NOT flag a reversed preference as a duplicate", () => {
    // Same bag of words as an existing memory, opposite meaning. This used to
    // be rejected, leaving the stale preference in place forever.
    expect(isDuplicate("prefers javascript over typescript", existing)).toBe(false);
  });

  it("does not flag unrelated or genuinely new facts", () => {
    expect(isDuplicate("lives in berlin germany", existing)).toBe(false);
    expect(isDuplicate("uses neovim as the main editor", existing)).toBe(false);
  });

  it("treats empty candidates as duplicates so they are never saved", () => {
    expect(isDuplicate("", existing)).toBe(true);
  });

  it("falls back to the bag-of-words result for one-word memories", () => {
    expect(isDuplicate("vegetarian", ["vegetarian"])).toBe(true);
    expect(isDuplicate("vegetarian", ["vegan"])).toBe(false);
  });
});

describe("parseExtractionJson", () => {
  it("parses the add/update/remove shape directly", () => {
    const parsed = parseExtractionJson(
      '{"add":["Uses Vim."],"update":[{"n":2,"content":"Lives in Berlin."}],"remove":[3]}',
    );
    expect(parsed).toEqual({
      add: ["Uses Vim."],
      update: [{ n: 2, content: "Lives in Berlin." }],
      remove: [3],
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    expect(parseExtractionJson('```json\n{"add":["A"],"update":[],"remove":[]}\n```')).toEqual({
      add: ["A"],
      update: [],
      remove: [],
    });
    expect(
      parseExtractionJson('Sure! Here it is: {"add":["B"],"update":[],"remove":[]} Hope that helps.'),
    ).toEqual({ add: ["B"], update: [], remove: [] });
  });

  it("accepts the legacy {memories:[...]} shape as additions", () => {
    expect(parseExtractionJson('{"memories":["Legacy fact."]}')).toEqual({
      add: ["Legacy fact."],
      update: [],
      remove: [],
    });
  });

  it("drops malformed entries instead of failing the whole payload", () => {
    const parsed = parseExtractionJson(
      '{"add":["ok", 42, null],"update":[{"n":"1","content":"x"},{"n":1},{"n":2,"content":"fine"}],"remove":[1,"2",2.5]}',
    );
    expect(parsed).toEqual({
      add: ["ok"],
      update: [{ n: 2, content: "fine" }],
      remove: [1],
    });
  });

  it("returns null for prose or unrelated JSON", () => {
    expect(parseExtractionJson("")).toBeNull();
    expect(parseExtractionJson("Nothing to remember here.")).toBeNull();
    expect(parseExtractionJson('{"answer": 42}')).toBeNull();
  });
});

describe("selectMemoriesForPrompt", () => {
  const row = (id: number, created_at: number) => ({ id, created_at });

  it("returns the input untouched when under the cap", () => {
    const rows = [row(1, 10), row(2, 20)];
    expect(selectMemoriesForPrompt(rows, 5)).toBe(rows);
  });

  it("keeps the newest rows, in chronological order, when over the cap", () => {
    const rows = [row(1, 10), row(4, 40), row(2, 20), row(3, 30)];
    expect(selectMemoriesForPrompt(rows, 2).map((r) => r.id)).toEqual([3, 4]);
  });
});

describe("buildExtractorSystemPrompt", () => {
  it("numbers existing memories so update/remove can reference them", () => {
    const prompt = buildExtractorSystemPrompt(["First fact.", "Second fact."]);
    expect(prompt).toContain("1. First fact.");
    expect(prompt).toContain("2. Second fact.");
    expect(prompt).not.toContain("ALREADY KNOWN (global facts");
  });

  it("marks an empty list and lists already-known facts as uneditable", () => {
    const prompt = buildExtractorSystemPrompt([], ["Global fact."]);
    expect(prompt).toContain("(none yet)");
    expect(prompt).toContain("ALREADY KNOWN (global facts");
    expect(prompt).toContain("- Global fact.");
  });
});
