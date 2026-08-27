/**
 * LaTeX math rendering — detection, delimiter normalisation, and the lazy
 * KaTeX loader.
 *
 * Rendering LaTeX needs no opt-in — nobody prefers seeing `\frac{a}{b}` raw.
 * `$$…$$`, `\[…\]`, `\(…\)` and ```math fences are unambiguous and always
 * render. `$…$` — the delimiter most models actually use for inline math —
 * collides with the currency sign, so it renders only when the span passes
 * the Pandoc-style heuristics in `SINGLE_DOLLAR_SRC` below: those accept
 * essentially all model-written math while rejecting essentially all prose
 * about money ("it costs $5 and $10" has whitespace before the closing `$`
 * and a digit after it — twice over). A heuristic beats the on/off setting
 * it replaced, which was wrong in both positions: off, real math rendered as
 * TeX soup; on, prices typeset as formulas.
 *
 * What IS deferred is the engine itself. KaTeX is ~270 KB of JS plus a 29 KB
 * stylesheet and 59 font files — all bundled into the installer, never
 * fetched over the network, but no reason to read and parse any of it on a
 * launch that never renders a formula. A dynamic `import()` fires the first
 * time a message actually looks like it contains math; until it resolves the
 * message renders through the normal pipeline, and `subscribeMath` re-renders
 * it once the plugins are ready.
 */

import type { Options } from "react-markdown";
import { logger } from "@/lib/logger";

type PluginList = NonNullable<Options["rehypePlugins"]>;

/** The remark/rehype plugin pair, referentially stable once loaded. */
export interface MathPlugins {
  remark: PluginList;
  rehype: PluginList;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Every delimiter except `$…$` is unambiguous — `$$`, `\[`, `\(` and a ```math
// fence have no meaning in prose, so spotting one is reason enough to pull in
// the engine.
const UNAMBIGUOUS_RE = /\$\$|\\\[|\\\(|```[ \t]*math\b/;

// A `$…$` span that is *math*, not money. Every part earns its keep:
//   `(?<![\w$\\])` — the opener can't follow a word character ("US$5", "50$"),
//       another `$` (that's a `$$` fence), or a backslash (`\$` is an escaped
//       dollar sign).
//   `(?=\S)` / `(?<![\s\\])` — the content hugs both delimiters. "it costs
//       $5 and $10" dies here: the only closing candidate has a space before
//       it. The trailing `\` exclusion keeps `$…\$` (escaped dollar) inert.
//   `[^$\n]{1,200}?` — spans never cross a line break or contain a `$`, and
//       the bound keeps the scan linear on a long reply with a stray `$`.
//   `(?![\d$])` — a digit after the closer means it opened a second price
//       ("between $5-$10", "paid $25 ($5 each)"); `$` means we clipped a
//       `$$` fence.
// Residual risk is a glued non-currency pair like `$FOO=$BAR` in unquoted
// prose — rare, and the failure (typeset as italic text) is milder than the
// inverse failure of never rendering `$x^2$` at all.
const SINGLE_DOLLAR_SRC = String.raw`(?<![\w$\\])\$(?=\S)([^$\n]{1,200}?)(?<![\s\\])\$(?![\d$])`;
const SINGLE_DOLLAR_TEST = new RegExp(SINGLE_DOLLAR_SRC);
const SINGLE_DOLLAR_RE = new RegExp(SINGLE_DOLLAR_SRC, "g");

/** Cheap pre-check for "is it worth paying for KaTeX on this message?".
 *  Runs on the raw string — a `$…$` inside a code fence can trigger a
 *  spurious load, but a false positive costs one lazy import per session
 *  while a false negative would silently drop rendering. */
export function hasMath(content: string): boolean {
  return UNAMBIGUOUS_RE.test(content) || SINGLE_DOLLAR_TEST.test(content);
}

// ---------------------------------------------------------------------------
// Delimiter normalisation
// ---------------------------------------------------------------------------
//
// `remark-math` only understands `$…$` and `$$…$$`, and it only treats `$$` as
// *display* math when the fence sits on its own line. Three gaps follow, all
// common enough in model output to be worth closing here:
//
//   1. `\( … \)` / `\[ … \]` never reach `remark-math` at all — CommonMark
//      treats `\(` as an escaped paren and eats the backslash during parsing,
//      so `\[ E = mc^2 \]` renders as the literal text `[ E = mc^2 ]`.
//   2. `$$E = mc^2$$` written on a single line parses as *inline* math, so a
//      formula the model clearly meant to display gets squeezed into the
//      paragraph at text size.
//   3. `$…$` is only safe to hand to the parser after the currency
//      heuristics above have vetted it, so vetted spans are rewritten to the
//      `$$…$$` form and `singleDollarTextMath` stays off in remark-math —
//      money never reaches the parser as a candidate at all.
//
// All are fixed by rewriting the source string before react-markdown parses
// it. That rewrite must never touch code — the same trap as finding H5, where
// the TeX→Unicode fallback corrupted `cd path\to` and leaked the corruption
// into Copy / Export via `CodeBlock`'s `raw`. So `normalizeMath` walks fenced
// blocks and inline-code spans and rewrites only what falls between them.
//
// None of the multi-character spans may cross a blank line: a stray `\[` in
// one paragraph must not pair with a `\]` three paragraphs later and swallow
// the prose between them (LaTeX itself forbids blank lines in math mode, so
// this costs nothing legitimate). `NO_BLANK` is that guard.
const NO_BLANK = String.raw`(?:(?!\n[ \t]*\n)[\s\S])`;

/** `\( … \)` → `$$ … $$`. Inline either way — `$$…$$` mid-line parses as text
 *  math, not a display block. */
const PAREN_RE = new RegExp(String.raw`\\\((${NO_BLANK}*?)\\\)`, "g");
/** `\[ … \]` → `$$ … $$`; promoted to a display block by `DISPLAY_LINE_RE`
 *  below when it ends up alone on its line. */
const BRACKET_RE = new RegExp(String.raw`\\\[(${NO_BLANK}*?)\\\]`, "g");
/** A line that is nothing but `$$ … $$`. Split across three lines so
 *  `remark-math` sees flow (display) math rather than a long inline span.
 *  The body excludes `$` so `$$a$$ and $$b$$` — two inline formulas sharing a
 *  line — doesn't get mangled into one block. Leading whitespace is captured
 *  and replayed so display math nested in a list item stays in the item. */
const DISPLAY_LINE_RE = /^([ \t]*)\$\$[ \t]*([^\n$]+?)[ \t]*\$\$[ \t]*$/gm;
/** Inline code span: a backtick run, content, then a run of the same length.
 *  Blank-line-guarded like the math spans — CommonMark code spans can't
 *  contain a blank line either, so a stray lone backtick can't mask
 *  paragraphs of prose from the rewrite. */
const INLINE_CODE_RE = new RegExp(
  String.raw`(\x60+)${NO_BLANK}*?\1(?!\x60)`,
  "g",
);
/** An opening or closing fence at the start of a line. */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

// Order matters. `\[…\]` becomes `$$…$$` first so a bracket block alone on its
// line gets promoted to display by the second pass. The two *inline* rewrites
// — `\(…\)` and vetted `$…$` — run LAST, after that promotion: both produce
// `$$…$$`, and converting them earlier would let one sitting alone on a line
// be mistaken for a display block and centred, when inline math is inline
// wherever it lands.
function rewriteProse(text: string): string {
  return text
    .replace(BRACKET_RE, (_, body: string) => `$$${body}$$`)
    .replace(
      DISPLAY_LINE_RE,
      (_, indent: string, body: string) =>
        `${indent}$$\n${indent}${body}\n${indent}$$`,
    )
    .replace(PAREN_RE, (_, body: string) => `$$${body}$$`)
    .replace(SINGLE_DOLLAR_RE, (_, body: string) => `$$${body}$$`);
}

/** Apply `rewriteProse` to everything outside inline-code spans. */
function rewriteOutsideInlineCode(text: string): string {
  let out = "";
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(text)) !== null) {
    out += rewriteProse(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + rewriteProse(text.slice(last));
}

/**
 * Rewrite LaTeX delimiters into the forms `remark-math` understands, leaving
 * fenced blocks and inline code byte-for-byte intact.
 */
export function normalizeMath(src: string): string {
  // Nothing that could possibly need rewriting — skip the whole scan. Worth it
  // because this runs on every render of every message.
  if (!src.includes("$") && !src.includes("\\[") && !src.includes("\\(")) {
    return src;
  }

  const out: string[] = [];
  let prose: string[] = [];
  let inFence = false;
  let fenceChar = "";

  const flush = () => {
    if (prose.length) {
      out.push(rewriteOutsideInlineCode(prose.join("\n")));
      prose = [];
    }
  };

  for (const line of src.split("\n")) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        flush();
        inFence = true;
        fenceChar = ch;
        out.push(line);
        continue;
      }
      if (ch === fenceChar) {
        inFence = false;
        out.push(line);
        continue;
      }
    }
    if (inFence) out.push(line);
    else prose.push(line);
  }
  flush();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// KaTeX options
// ---------------------------------------------------------------------------

// Model output is untrusted, so the two open-ended knobs are pinned:
//   * `trust: false` (KaTeX's default, restated because it matters) makes
//     `\href` / `\url` / `\includegraphics` render as inert text instead of
//     emitting a live URL into the DOM.
//   * `maxSize` caps user-specified lengths. Without it `\rule{1e5em}{1e5em}`
//     renders at its literal size and blows the layout out of the window.
// `errorColor: currentColor` is a deliberate departure from KaTeX's red: a
// half-typed formula is the *normal* state mid-stream, and flashing red on
// every token is worse than quietly showing the source until it parses. The
// parse error still lands in the element's `title` for hover.
const KATEX_OPTIONS = {
  errorColor: "currentColor",
  maxSize: 50,
  strict: false,
  trust: false,
} as const;

// ---------------------------------------------------------------------------
// Lazy loader
// ---------------------------------------------------------------------------

let plugins: MathPlugins | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** The loaded plugin pair, or `null` while the chunk is still in flight.
 *  Stable by reference so it can back a `useSyncExternalStore` snapshot. */
export function getMathPlugins(): MathPlugins | null {
  return plugins;
}

export function subscribeMath(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Kick off the KaTeX import. Idempotent, and a no-op once loaded. */
export function loadMath(): void {
  if (plugins || pending) return;
  pending = import("./mathChunk")
    .then(({ remarkMath, rehypeKatex }) => {
      plugins = {
        // `$…$` never reaches remark-math — vetted spans arrive rewritten to
        // `$$…$$` by `normalizeMath`, so currency-looking text is never even
        // a candidate for the parser.
        remark: [[remarkMath, { singleDollarTextMath: false }]],
        rehype: [[rehypeKatex, KATEX_OPTIONS]],
      };
      for (const l of listeners) l();
    })
    .catch((e: unknown) => {
      // Leave `pending` set so a failed load isn't retried on every render;
      // messages keep rendering through the math-free pipeline.
      logger.error("math renderer failed to load", e);
    });
}
