// Coverage for the two pure helpers behind LaTeX rendering.
//
// `normalizeMath` rewrites the source string before react-markdown parses it,
// which puts it in exactly the position that caused finding H5: a pre-parse
// rewrite that didn't know about code corrupted `cd path\to` on screen AND in
// the `raw` that Copy / Export / the canvas read back out of the tree. Much of
// what follows is therefore about what it must NOT touch — with the `$…$`
// currency heuristics as the other load-bearing half: they are the reason the
// renderer can typeset `$x^2$` by default without typesetting price lists.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { hasMath, normalizeMath } from "./math";

// Realistic money-quoting prose. None of it may render as math, and none of
// it should even pull the engine in. Each entry defeats a different clause of
// the heuristic — see `SINGLE_DOLLAR_SRC` in math.ts.
const CURRENCY = [
  "It costs $5 and $10 total.", // space before every closing candidate
  "between $5-$10 each way", // digit after the would-be closer
  "paid $25 ($5 each)", // ditto, with punctuation in the span
  "50$ and 60$ down", // suffix style: opener glued to a word char
  "US$5 vs CA$10", // prefix style: same
  "a $100M raise and $5B valuation", // space before the closing candidate
  "escaped \\$5 and \\$10 stay put", // `\$` is an escaped dollar sign
];

describe("hasMath", () => {
  it("spots every unambiguous delimiter", () => {
    expect(hasMath("$$E = mc^2$$")).toBe(true);
    expect(hasMath("block:\n$$\nE = mc^2\n$$")).toBe(true);
    expect(hasMath("inline \\( a + b \\) here")).toBe(true);
    expect(hasMath("display \\[ a + b \\] here")).toBe(true);
    expect(hasMath("```math\na + b\n```")).toBe(true);
  });

  it("spots a $…$ span that passes the currency heuristics", () => {
    expect(hasMath("the ratio $x^2$ holds")).toBe(true);
    expect(hasMath("so $\\alpha + \\beta$ works")).toBe(true);
  });

  it("stays quiet on money and mathless prose", () => {
    for (const src of CURRENCY) expect(hasMath(src), src).toBe(false);
    expect(hasMath("no math at all here")).toBe(false);
    expect(hasMath("a lone $ sign")).toBe(false);
    // A `$` pair has to sit on one line — this is the shape a shell snippet
    // spread over several lines takes, and it must not pull in the chunk.
    expect(hasMath("export FOO=1\nrun $BAR\nthen $BAZ")).toBe(false);
  });
});

describe("normalizeMath — delimiter rewriting", () => {
  it("converts \\( … \\) to the two-dollar inline form", () => {
    expect(normalizeMath("Paren \\( a_1 + a_2 \\) here.")).toBe(
      "Paren $$ a_1 + a_2 $$ here.",
    );
  });

  it("does not centre a \\( … \\) that happens to sit alone on its line", () => {
    // It converts to `$$…$$`, which the display promotion would otherwise
    // mistake for a block. Inline math is inline wherever it lands, so the
    // paren rewrite has to run after that pass.
    expect(normalizeMath("text:\n\\( a + b \\)\nmore")).toBe(
      "text:\n$$ a + b $$\nmore",
    );
  });

  it("converts a standalone \\[ … \\] to a display block", () => {
    expect(normalizeMath("Text:\n\n\\[ E = mc^2 \\]\n")).toBe(
      "Text:\n\n$$\nE = mc^2\n$$\n",
    );
  });

  it("promotes a single-line $$ … $$ to a display block", () => {
    // remark-math only treats `$$` as *display* math when the fence is alone
    // on its line; without this the formula renders inline at text size.
    expect(normalizeMath("$$\\frac{a}{b}$$")).toBe("$$\n\\frac{a}{b}\n$$");
  });

  it("keeps display math inside a list item indented", () => {
    expect(normalizeMath("- step:\n  $$x = 1$$\n- next")).toBe(
      "- step:\n  $$\n  x = 1\n  $$\n- next",
    );
  });

  it("leaves an already-fenced display block alone", () => {
    const src = "Text:\n\n$$\n\\frac{a}{b}\n$$\n";
    expect(normalizeMath(src)).toBe(src);
  });

  it("does not merge two inline formulas sharing a line", () => {
    const src = "$$a$$ and $$b$$";
    expect(normalizeMath(src)).toBe(src);
  });

  it("returns the input unchanged when there is nothing to rewrite", () => {
    const src = "plain prose with a (paren) and no dollars or brackets";
    expect(normalizeMath(src)).toBe(src);
  });
});

describe("normalizeMath — $…$ currency heuristics", () => {
  it("converts a vetted math span to the two-dollar form", () => {
    expect(normalizeMath("The identity $x^2$ holds.")).toBe(
      "The identity $$x^2$$ holds.",
    );
    expect(normalizeMath("$\\alpha$ leads")).toBe("$$\\alpha$$ leads");
    expect(normalizeMath("ends with $a_i + b_i$")).toBe(
      "ends with $$a_i + b_i$$",
    );
    // Digits inside are fine — only a digit AFTER the closer smells of money.
    expect(normalizeMath("about $\\pi \\approx 3.14$ then")).toBe(
      "about $$\\pi \\approx 3.14$$ then",
    );
  });

  it("converts math even when money precedes it on the same line", () => {
    expect(normalizeMath("It costs $5 but $x^2$ still renders")).toBe(
      "It costs $5 but $$x^2$$ still renders",
    );
  });

  it("leaves every currency shape untouched", () => {
    for (const src of CURRENCY) expect(normalizeMath(src), src).toBe(src);
  });

  it("requires the span to hug both delimiters", () => {
    expect(normalizeMath("loose $ x $ stays")).toBe("loose $ x $ stays");
    expect(normalizeMath("half-loose $x $ stays")).toBe("half-loose $x $ stays");
  });

  it("never crosses a line break", () => {
    const src = "opened $x\nclosed y$ apart";
    expect(normalizeMath(src)).toBe(src);
  });

  it("does not open after a word character or clip a $$ fence", () => {
    expect(normalizeMath("glued word$x$ stays")).toBe("glued word$x$ stays");
    const fence = "$$a + b$$ tail"; // promotion doesn't apply (trailing text)
    expect(normalizeMath(fence)).toBe(fence);
  });

  it("converts several spans on one line", () => {
    // The opener's guard consumes the character before the `$` rather than
    // looking behind it (Safari < 16.4 has no lookbehind, and this module is
    // in the entry chunk). That character must be replayed, and it must not
    // starve the next span of its own guard.
    expect(normalizeMath("both $x$ and $y$ render")).toBe(
      "both $$x$$ and $$y$$ render",
    );
    expect(normalizeMath("($a$)($b$)")).toBe("($$a$$)($$b$$)");
    expect(normalizeMath("$x$ leads")).toBe("$$x$$ leads");
  });

  it("has no lookbehind in its patterns", () => {
    // Guards the boot path, not the behaviour: a `new RegExp` JavaScriptCore
    // can't compile throws while the entry chunk is evaluating, before React
    // mounts or any error boundary exists — a blank window on macOS 11/12.
    const source = readFileSync(
      new URL("./math.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\(\?<[=!]/);
  });
});

describe("normalizeMath — code is never touched", () => {
  it("leaves fenced blocks byte-for-byte intact", () => {
    // `\(` … `\)` is BRE grouping — real shell, and the exact kind of thing
    // a blind string rewrite would corrupt.
    const src = [
      "Before \\( x \\) after.",
      "",
      "```bash",
      "sed 's/\\(a\\)/\\1/' file",
      "echo $$ and $$PPID",
      "echo $HOME$USER",
      "```",
      "",
      "After \\( y \\).",
    ].join("\n");
    const out = normalizeMath(src);
    expect(out).toContain("sed 's/\\(a\\)/\\1/' file");
    expect(out).toContain("echo $$ and $$PPID");
    expect(out).toContain("echo $HOME$USER");
    // …while the prose on either side still converts.
    expect(out).toContain("Before $$ x $$ after.");
    expect(out).toContain("After $$ y $$.");
  });

  it("leaves tilde fences intact", () => {
    const src = "~~~\ngrep '\\(foo\\)'\n~~~";
    expect(normalizeMath(src)).toBe(src);
  });

  it("leaves inline code spans intact", () => {
    const out = normalizeMath("run `sed 's/\\(a\\)/\\1/'` then \\( b \\)");
    expect(out).toBe("run `sed 's/\\(a\\)/\\1/'` then $$ b $$");
    expect(normalizeMath("costs `$x$` literally")).toBe(
      "costs `$x$` literally",
    );
  });

  it("does not promote a $$ … $$ line that is inline code", () => {
    const src = "`$$x$$`";
    expect(normalizeMath(src)).toBe(src);
  });

  it("leaves an indented code block intact", () => {
    // Four-space blocks are code too, and shell written that way is full of
    // both BRE grouping and `$VAR$VAR` pairs the currency heuristic accepts.
    const src = [
      "Run this:",
      "",
      "    sed 's/\\(a\\)/\\1/' file",
      "    echo $HOME/$USER",
      "",
      "Then \\( y \\).",
    ].join("\n");
    const out = normalizeMath(src);
    expect(out).toContain("    sed 's/\\(a\\)/\\1/' file");
    expect(out).toContain("    echo $HOME/$USER");
    expect(out).toContain("Then $$ y $$.");
  });

  it("keeps an indented block together across a blank line", () => {
    const src = ["x:", "", "    \\(a\\)", "", "    \\(b\\)"].join("\n");
    const out = normalizeMath(src);
    expect(out).toContain("    \\(a\\)");
    expect(out).toContain("    \\(b\\)");
  });

  it("leaves a fence nested in a list item intact", () => {
    // The fence sits four columns in, past the three CommonMark allows
    // *relative to the document* but legal relative to the list item.
    const src = [
      "- outer",
      "  - inner:",
      "",
      "    ```bash",
      "    sed 's/\\(a\\)/\\1/' f",
      "    ```",
    ].join("\n");
    expect(normalizeMath(src)).toContain("sed 's/\\(a\\)/\\1/' f");
  });

  it("does not let a short inner fence close a longer outer one", () => {
    // A ```` block whose body shows ``` fenced markdown: the inner run is
    // content, so the `$$…$$` in the example must survive as written.
    const src = [
      "````markdown",
      "```",
      "inner \\(code\\) and $x$ here",
      "```",
      "````",
    ].join("\n");
    expect(normalizeMath(src)).toBe(src);
  });

  it("still rewrites math indented inside a list item", () => {
    // Two columns in is list content, not code — the formula must render.
    const src = ["- item", "", "  \\( x \\)"].join("\n");
    expect(normalizeMath(src)).toContain("  $$ x $$");
  });
});

describe("normalizeMath — spans never cross a blank line", () => {
  it("a stray \\[ cannot pair with a \\] paragraphs later", () => {
    const src = "an array literal \\[ opens here\n\nprose between\n\nand \\] closes";
    expect(normalizeMath(src)).toBe(src);
  });

  it("…while a genuine multi-line display block still converts", () => {
    expect(normalizeMath("\\[\na + b\n\\]")).toBe("$$\na + b\n$$");
  });

  it("a lone backtick cannot mask later paragraphs from the rewrite", () => {
    const out = normalizeMath(
      "stray ` tick\n\nthen \\( x \\) here\n\nand ` another",
    );
    expect(out).toContain("then $$ x $$ here");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: normalised source → the real parser, asserting node kinds.
//
// `singleDollarTextMath` is pinned OFF exactly as `loadMath` configures it —
// `$…$` reaches the parser only via `normalizeMath`'s heuristic rewrite to
// `$$…$$`, so money is never even a candidate. Reaching for micromark/mdast
// directly rather than `remark-math` keeps `unified` out of the test deps;
// `remark-math` is a thin wrapper over exactly these two and is what supplies
// them.
// ---------------------------------------------------------------------------

/** Parse through the real pipeline; returns e.g. `["math:E = mc^2"]`.
 *  `math:` is a centred display block, `inlineMath:` sits in the text flow. */
function parse(src: string): string[] {
  interface Node {
    type: string;
    value?: string;
    children?: Node[];
  }
  const tree = fromMarkdown(normalizeMath(src), {
    extensions: [math({ singleDollarTextMath: false })],
    mdastExtensions: [mathFromMarkdown()],
  }) as unknown as Node;
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === "math" || n.type === "inlineMath")
      out.push(`${n.type}:${n.value}`);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

describe("pipeline — every delimiter renders, money never does", () => {
  it("renders each delimiter through the real parser", () => {
    expect(parse("$$E = mc^2$$")).toEqual(["math:E = mc^2"]);
    expect(parse("text\n\n$$\nE = mc^2\n$$\n")).toEqual(["math:E = mc^2"]);
    expect(parse("\\[ E = mc^2 \\]")).toEqual(["math:E = mc^2"]);
    expect(parse("Euler: \\( e^{i\\pi} \\) neat.")).toEqual([
      "inlineMath:e^{i\\pi}",
    ]);
    expect(parse("The identity $x^2$ holds.")).toEqual(["inlineMath:x^2"]);
  });

  it("keeps \\(…\\) inline — never promoted to a display block", () => {
    // It normalises to `$$…$$`, which the display pass would centre if the
    // rewrites ran in the wrong order. Inline math is inline wherever it sits.
    expect(parse("text:\n\\( a + b \\)\nmore")).toEqual(["inlineMath:a + b"]);
  });

  it("parses no math out of money", () => {
    for (const src of CURRENCY) expect(parse(src), src).toEqual([]);
  });
});
