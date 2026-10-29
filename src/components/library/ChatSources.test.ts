// The composer's `#` mention: when it opens, and what it offers.

import { describe, expect, it } from "vitest";
import { chatNumCtx, matchMentions, mentionAt } from "./ChatSources";
import { DEFAULT_PARAMS, type LibraryDataset, type LibraryItemMeta } from "@/types";

describe("mentionAt", () => {
  it("finds the #token right before the caret", () => {
    expect(mentionAt("look at #road", 13)).toEqual({ start: 8, query: "road" });
    expect(mentionAt("#", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("line one\n#q", 11)).toEqual({ start: 9, query: "q" });
  });

  it("ignores # inside words, after a space, and away from the caret", () => {
    expect(mentionAt("C# rocks", 2)).toBeNull();
    expect(mentionAt("https://x.dev/#top", 18)).toBeNull();
    expect(mentionAt("# Heading", 9)).toBeNull();
    expect(mentionAt("#road trip", 10)).toBeNull();
  });
});

describe("matchMentions", () => {
  const item = (id: string, title: string, updated_at: number): LibraryItemMeta =>
    ({ id, title, kind: "text", media: "text", chars: 400, updated_at }) as LibraryItemMeta;
  const items = [item("1", "Road trip notes", 1), item("2", "Roadmap Q3", 3), item("3", "Offroad gear", 2)];
  const datasets: LibraryDataset[] = [
    { id: "d", name: "Product roadmap", description: "", item_ids: ["2"], created_at: 0, updated_at: 5 },
  ];

  it("ranks prefix, then word-start, then substring matches", () => {
    expect(matchMentions("road", items, datasets).map((e) => e.title)).toEqual([
      "Roadmap Q3",
      "Road trip notes",
      "Product roadmap",
      "Offroad gear",
    ]);
  });

  it("lists everything newest-first for an empty query, up to the limit", () => {
    expect(matchMentions("", items, datasets, 2).map((e) => e.id)).toEqual(["d", "2"]);
  });
});

// The window the sources estimate is sized against has to be the one the
// send uses: `chatStore.readSessionParams` layers the model's default, then
// the Space's params, then the chat's own.
describe("chatNumCtx", () => {
  const ctx = (n: number) => JSON.stringify({ num_ctx: n });

  it("falls back to the app default, then the model's own window", () => {
    expect(chatNumCtx(null, null)).toBe(DEFAULT_PARAMS.num_ctx);
    expect(chatNumCtx(undefined, undefined, 2048)).toBe(2048);
    expect(chatNumCtx(null, null, 0)).toBe(DEFAULT_PARAMS.num_ctx);
  });

  it("lets the Space override the model, and the chat override both", () => {
    expect(chatNumCtx(null, ctx(16384), 2048)).toBe(16384);
    expect(chatNumCtx(ctx(65536), ctx(16384), 2048)).toBe(65536);
    expect(chatNumCtx(ctx(65536), null, 2048)).toBe(65536);
  });

  it("skips a layer without a usable num_ctx", () => {
    expect(chatNumCtx(JSON.stringify({ temperature: 0.2 }), ctx(16384), 2048)).toBe(16384);
    expect(chatNumCtx("{not json", ctx(16384))).toBe(16384);
    expect(chatNumCtx(JSON.stringify({ num_ctx: "big" }), null, 2048)).toBe(2048);
  });
});
