// Coverage for the palette's `in:<scope>` parser.
//
// It's the seam the whole scoping feature hangs off: three separate consumers
// read its output — the result filter, the backend message search, and the
// highlight overlay, which indexes the RAW query with the character offsets
// this returns. An off-by-one there draws the box around the wrong word, which
// no type-check would catch.

import { describe, it, expect } from "vitest";
import { __testing } from "./SearchBar";

const { parseQuery } = __testing;

describe("parseQuery", () => {
  it("defaults to searching everywhere", () => {
    expect(parseQuery("mitochondria")).toEqual({
      scope: "everywhere",
      terms: "mitochondria",
      token: null,
    });
  });

  it("reads a leading token and lifts it out of the terms", () => {
    const p = parseQuery("in:messages powerhouse");
    expect(p.scope).toBe("messages");
    expect(p.terms).toBe("powerhouse");
    expect(p.token).toEqual({ start: 0, end: 11 });
  });

  it("accepts the token after the terms too", () => {
    const p = parseQuery("powerhouse in:chats");
    expect(p.scope).toBe("chats");
    expect(p.terms).toBe("powerhouse");
    // Offsets index the RAW query — that's what the overlay renders.
    expect("powerhouse in:chats".slice(p.token!.start, p.token!.end)).toBe(
      "in:chats",
    );
  });

  it("closes the gap a mid-query token leaves behind", () => {
    // A plain `.trim()` would leave "alpha  beta" with a double space here.
    expect(parseQuery("alpha in:spaces beta").terms).toBe("alpha beta");
  });

  it("is case-insensitive but reports the scope in lower case", () => {
    const p = parseQuery("IN:Snippets Fix");
    expect(p.scope).toBe("snippets");
    expect(p.terms).toBe("Fix");
    expect("IN:Snippets Fix".slice(p.token!.start, p.token!.end)).toBe(
      "IN:Snippets",
    );
  });

  it("leaves an unknown scope as ordinary search text", () => {
    // No silent narrowing, and no box drawn around something inert.
    expect(parseQuery("in:bogus alpha")).toEqual({
      scope: "everywhere",
      terms: "in:bogus alpha",
      token: null,
    });
  });

  it("ignores `in:` glued to other text", () => {
    // Only a standalone word is a filter — otherwise searching for a URL like
    // "domain.in:chats" would silently scope the query.
    expect(parseQuery("domain.in:chats").scope).toBe("everywhere");
    expect(parseQuery("in:chatsx").scope).toBe("everywhere");
  });

  it("treats a bare token as a scope with nothing to match yet", () => {
    // The trailing space the dropdown leaves behind must parse the same as
    // the token on its own.
    for (const q of ["in:messages", "in:messages "]) {
      const p = parseQuery(q);
      expect(p.scope).toBe("messages");
      expect(p.terms).toBe("");
    }
  });

  it("does not accept in:everywhere — that scope is the absence of a token", () => {
    expect(parseQuery("in:everywhere alpha").scope).toBe("everywhere");
    expect(parseQuery("in:everywhere alpha").token).toBeNull();
  });
});
