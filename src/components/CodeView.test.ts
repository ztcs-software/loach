// `escapeHtml` is all that stands between model-written code and
// `dangerouslySetInnerHTML` when the canvas shows a block unhighlighted —
// while it streams, and past the highlight size cap.

import { describe, it, expect } from "vitest";
import { escapeHtml } from "./CodeView";

describe("escapeHtml", () => {
  it("escapes every character that could open markup or an attribute", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&amp;`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;amp;",
    );
  });

  it("escapes the ampersand first, so nothing is escaped twice", () => {
    expect(escapeHtml("a < b && c")).toBe("a &lt; b &amp;&amp; c");
  });

  it("leaves everything else, whitespace included, as it was", () => {
    expect(escapeHtml("let x = 1;\n\tx += 2 // ok")).toBe("let x = 1;\n\tx += 2 // ok");
  });
});
