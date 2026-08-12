import { describe, expect, it } from "vitest";
import { buildShareUrl, truncate } from "./share";
import { wrapLines } from "./shareImage";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hello", 20)).toBe("hello");
  });

  it("clips to the limit with an ellipsis", () => {
    const out = truncate("a".repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildShareUrl", () => {
  it("puts the text in X's intent", () => {
    const url = new URL(buildShareUrl("x", "hello world"));
    expect(url.host).toBe("x.com");
    expect(url.searchParams.get("text")).toBe("hello world");
  });

  it("clamps X to a postable length", () => {
    const url = new URL(buildShareUrl("x", "a".repeat(1000)));
    expect(url.searchParams.get("text")!.length).toBeLessThanOrEqual(280);
  });

  it("titles a Reddit self-post from the first line", () => {
    const url = new URL(buildShareUrl("reddit", "The headline\n\nthe body"));
    expect(url.searchParams.get("title")).toBe("The headline");
    expect(url.searchParams.get("text")).toBe("The headline\n\nthe body");
  });

  it("still gives Reddit a title when the text starts with blank lines", () => {
    const url = new URL(buildShareUrl("reddit", "\n\n  \nactual text"));
    expect(url.searchParams.get("title")).toBe("actual text");
  });

  it("pairs Facebook's required link with the message as the quote", () => {
    const url = new URL(buildShareUrl("facebook", "hello"));
    expect(url.searchParams.get("u")).toContain("github.com/ztcs-software/loach");
    expect(url.searchParams.get("quote")).toBe("hello");
  });

  it("opens LinkedIn's composer with the text", () => {
    const url = new URL(buildShareUrl("linkedin", "hello"));
    expect(url.searchParams.get("shareActive")).toBe("true");
    expect(url.searchParams.get("text")).toBe("hello");
  });
});

// One "character" per unit of width keeps the expectations readable.
const measure = (s: string) => s.length;

describe("wrapLines", () => {
  it("wraps on word boundaries", () => {
    expect(wrapLines("aaa bbb ccc ddd", 7, measure)).toEqual([
      "aaa bbb",
      "ccc ddd",
    ]);
  });

  it("keeps explicit newlines, including blank ones", () => {
    expect(wrapLines("one\n\ntwo", 20, measure)).toEqual(["one", "", "two"]);
  });

  it("hard-splits a word wider than the line", () => {
    expect(wrapLines("aaaaaaaa", 3, measure)).toEqual(["aaa", "aaa", "aa"]);
  });

  it("flushes the current line before hard-splitting", () => {
    expect(wrapLines("hi wwwwww", 4, measure)).toEqual(["hi", "wwww", "ww"]);
  });

  it("preserves leading indentation", () => {
    expect(wrapLines("    indented", 20, measure)).toEqual(["    indented"]);
  });

  it("never emits a line wider than the limit", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    for (const line of wrapLines(text, 11, measure)) {
      expect(line.length).toBeLessThanOrEqual(11);
    }
  });
});
