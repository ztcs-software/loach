// Regression coverage for the markdown-safety fixes (findings H5 and H8).
//
// H5: the TeX→Unicode fallback used to rewrite the whole message string before
// parsing, mangling code (`cd path\to` → `cd path→`, `\alpha` in fences) in the
// render AND in the `raw` that Copy/Export/Canvas read back. It now runs as a
// rehype pass that skips `<code>`/`<pre>` subtrees.
// H8: assistant links are opened through the OS handler only for allow-listed
// schemes; javascript:/file:/data:/relative hrefs are refused.

import { describe, it, expect } from "vitest";
import { __testing, stableBlocks, stableSplit } from "./Markdown";

const { texReplace, rehypeTexFallback, shouldOpenExternally, rehypeHighlightCapped } =
  __testing;

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

  it("leaves remark-math nodes alone so KaTeX gets intact TeX", () => {
    // `remark-math` emits inline math as `<code class="math-inline">` and
    // display math as `<pre><code class="math-display">`, so the code/pre skip
    // above is what keeps this pass off real math. Without it `\sqrt{c}`
    // would reach KaTeX as `√{c}` and fail to parse.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree: any = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-inline"] },
          children: [{ type: "text", value: "\\sqrt{c} + \\alpha" }],
        },
        {
          type: "element",
          tagName: "pre",
          children: [
            {
              type: "element",
              tagName: "code",
              properties: { className: ["language-math", "math-display"] },
              children: [{ type: "text", value: "\\sum_{i=1}^{n} \\theta_i" }],
            },
          ],
        },
      ],
    };
    rehypeTexFallback()(tree);
    expect(tree.children[0].children[0].value).toBe("\\sqrt{c} + \\alpha");
    expect(tree.children[1].children[0].children[0].value).toBe(
      "\\sum_{i=1}^{n} \\theta_i",
    );
  });
});

describe("stableSplit (streaming prefix/tail boundary)", () => {
  // Round-trip helper — the split must never lose or reorder a byte.
  const split = (s: string) => {
    const at = stableSplit(s);
    const stable = s.slice(0, at);
    const tail = s.slice(at);
    expect(stable + tail).toBe(s);
    return [stable, tail] as const;
  };

  it("cuts at the last top-level blank line", () => {
    const [stable, tail] = split("para one\n\npara two\n\npara three");
    expect(stable).toBe("para one\n\npara two\n\n");
    expect(tail).toBe("para three");
  });

  it("returns 0 for a single still-growing block (no boundary yet)", () => {
    expect(stableSplit("still typing the first paragraph")).toBe(0);
  });

  it("never splits inside an open code fence", () => {
    // The blank line is INSIDE the unterminated fence, so the whole block must
    // stay in the tail (rendered without highlight) until the fence closes.
    const [stable, tail] = split("intro\n\n```py\na = 1\n\nb = 2");
    expect(stable).toBe("intro\n\n");
    expect(tail).toBe("```py\na = 1\n\nb = 2");
  });

  it("treats a blank line after a CLOSED fence as a boundary", () => {
    const [stable, tail] = split("```py\nx = 1\n```\n\nnext para");
    expect(stable).toBe("```py\nx = 1\n```\n\n");
    expect(tail).toBe("next para");
  });

  it("puts everything in the stable prefix when content ends at a boundary", () => {
    // A pause at a block boundary (content ending in a blank line) renders
    // everything as the highlighted, memoised prefix and an empty tail.
    const [stable, tail] = split("a\n\nb\n\n");
    expect(stable).toBe("a\n\nb\n\n");
    expect(tail).toBe("");
  });

  it("never splits inside an open $$ display-math block", () => {
    // Cutting at the blank line between stacked equations would leave the
    // prefix holding an unclosed `$$` and let the tail's closer open a block
    // that typesets the prose after it.
    const [stable, tail] = split("intro\n\n$$\na = b\n\nc = d");
    expect(stable).toBe("intro\n\n");
    expect(tail).toBe("$$\na = b\n\nc = d");
  });

  it("treats a blank line after a CLOSED math block as a boundary", () => {
    const [stable, tail] = split("$$\na = b\n$$\n\nnext para");
    expect(stable).toBe("$$\na = b\n$$\n\n");
    expect(tail).toBe("next para");
  });

  it("ignores $$ inside a code fence", () => {
    const [stable, tail] = split("```sh\necho $$\n```\n\nnext para");
    expect(stable).toBe("```sh\necho $$\n```\n\n");
    expect(tail).toBe("next para");
  });

  it("doesn't close a fence on a line with an info string or a shorter run", () => {
    // A markdown sample quoting a fenced block: neither "```js" nor the
    // three-backtick line closes the four-backtick fence around it.
    const open = "intro\n\n````markdown\n```js\nlet a;\n\n```\n\nmore";
    const [stable, tail] = split(open);
    expect(stable).toBe("intro\n\n");
    expect(tail).toBe(open.slice("intro\n\n".length));
    // An opener with an info string can't close a ``` block either.
    expect(split("```md\n```js\n\nx")[0]).toBe("");
  });
});

describe("stableBlocks (memoised pieces of the stable prefix)", () => {
  it("cuts at each top-level blank line, without losing a byte", () => {
    const prefix = "# Title\n\npara one\n\n```py\na = 1\n\nb = 2\n```\n\n";
    const blocks = stableBlocks(prefix);
    expect(blocks).toEqual(["# Title\n\n", "para one\n\n", "```py\na = 1\n\nb = 2\n```\n\n"]);
    expect(blocks.join("")).toBe(prefix);
  });

  it("keeps a loose list and an item's indented paragraphs in one block", () => {
    const prefix = "- one\n\n- two\n\n  more about two\n\n\n1. three\n\nafter\n\n";
    expect(stableBlocks(prefix)).toEqual([
      "- one\n\n- two\n\n  more about two\n\n\n1. three\n\n",
      "after\n\n",
    ]);
  });

  it("gives an empty prefix no blocks", () => {
    expect(stableBlocks("")).toEqual([]);
  });
});

describe("rehypeHighlightCapped", () => {
  const block = (text: string) => {
    const code = {
      type: "element",
      tagName: "code",
      properties: { className: ["language-js"] },
      children: [{ type: "text", value: text }],
    };
    return { tree: { type: "root", children: [{ type: "element", tagName: "pre", children: [code] }] }, code };
  };

  it("highlights an ordinary block", () => {
    const { tree, code } = block("const a = 1;");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rehypeHighlightCapped()(tree as any, {} as any);
    expect(code.properties.className).toEqual(["hljs", "language-js"]);
    expect(code.children.length).toBeGreaterThan(1);
  });

  it("leaves a very large block as plain text, classes as they were", () => {
    const text = "const a = 1;\n".repeat(5000);
    const { tree, code } = block(text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rehypeHighlightCapped()(tree as any, {} as any);
    expect(code.properties.className).toEqual(["language-js"]);
    expect(code.children).toEqual([{ type: "text", value: text }]);
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
