// Regression coverage for the markdown-safety fixes (findings H5 and H8).
//
// H5: the TeX→Unicode fallback used to rewrite the whole message string before
// parsing, mangling code (`cd path\to` → `cd path→`, `\alpha` in fences) in the
// render AND in the `raw` that Copy/Export/Canvas read back. It now runs as a
// rehype pass that skips `<code>`/`<pre>` subtrees.
// H8: assistant links are opened through the OS handler only for allow-listed
// schemes; javascript:/file:/data:/relative hrefs are refused.

import { describe, it, expect } from "vitest";
import { __testing } from "./Markdown";

const { texReplace, rehypeTexFallback, shouldOpenExternally } = __testing;

describe("texReplace (prose TeX→Unicode fallback)", () => {
  it("converts known single-token TeX", () => {
    expect(texReplace("x \\rightarrow y")).toBe("x → y");
    expect(texReplace("$\\alpha$ and $\\beta$")).toBe("α and β");
  });

  it("leaves unknown or multi-token TeX untouched", () => {
    expect(texReplace("\\frac{a}{b}")).toBe("\\frac{a}{b}");
    expect(texReplace("\\unknowncmd")).toBe("\\unknowncmd");
  });
});

// Minimal hast fixture: prose, a fenced code block, and inline code.
function fixture() {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        children: [{ type: "text", value: "go \\alpha now" }],
      },
      {
        type: "element",
        tagName: "pre",
        children: [
          {
            type: "element",
            tagName: "code",
            children: [{ type: "text", value: "cd path\\to and \\alpha" }],
          },
        ],
      },
      {
        type: "element",
        tagName: "p",
        children: [
          { type: "text", value: "before " },
          {
            type: "element",
            tagName: "code",
            children: [{ type: "text", value: "\\beta" }],
          },
          { type: "text", value: " after \\beta" },
        ],
      },
    ],
  };
}

describe("rehypeTexFallback", () => {
  it("rewrites prose text but never touches code / pre subtrees", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree: any = fixture();
    rehypeTexFallback()(tree);

    // Prose converts.
    expect(tree.children[0].children[0].value).toBe("go α now");
    // Fenced code is byte-for-byte intact (the H5 corruption case).
    expect(tree.children[1].children[0].children[0].value).toBe(
      "cd path\\to and \\alpha",
    );
    // Inline code intact; surrounding prose converts.
    const p2 = tree.children[2];
    expect(p2.children[0].value).toBe("before ");
    expect(p2.children[1].children[0].value).toBe("\\beta");
    expect(p2.children[2].value).toBe(" after β");
  });
});

describe("shouldOpenExternally (link scheme allow-list)", () => {
  it("allows absolute http / https / mailto", () => {
    expect(shouldOpenExternally("https://example.com")).toBe(true);
    expect(shouldOpenExternally("http://example.com/x")).toBe(true);
    expect(shouldOpenExternally("mailto:a@b.com")).toBe(true);
  });

  it("refuses dangerous schemes and non-absolute hrefs", () => {
    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
    expect(shouldOpenExternally("file:///etc/passwd")).toBe(false);
    expect(shouldOpenExternally("data:text/html,<script>")).toBe(false);
    expect(shouldOpenExternally("/relative/path")).toBe(false);
    expect(shouldOpenExternally("#anchor")).toBe(false);
    expect(shouldOpenExternally("")).toBe(false);
    expect(shouldOpenExternally(undefined)).toBe(false);
  });
});
