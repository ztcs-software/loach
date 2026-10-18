// The composer's `#` mention: when it opens, and what it offers.

import { describe, expect, it } from "vitest";
import { matchMentions, mentionAt } from "./ChatSources";
import type { LibraryDataset, LibraryItemMeta } from "@/types";

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
