import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { CodeBlock } from "./CodeBlock";
import { cn } from "@/lib/utils";
import { openExternal } from "@/lib/tauri";

interface MarkdownProps {
  content: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// LaTeX-style symbol fallback
//
// Models routinely emit small bits of TeX like `$\rightarrow$` or `$\to$` even
// when the user hasn't asked for math. Pulling in a full math stack
// (`remark-math` + `rehype-katex` + the KaTeX CSS) is ~500 KB of JS for what
// is, in practice, a handful of arrow / set / Greek symbols. So instead we
// run a cheap textual rewrite *before* react-markdown sees the string and
// convert the most common single-token TeX commands into their Unicode
// equivalents. Anything we don't recognise is left untouched, so genuine
// inline math (e.g. `$x^2 + y^2$`) still renders verbatim — which at least
// reads better than `\rightarrow` slipping through as literal text.
// ---------------------------------------------------------------------------

const TEX_SYMBOLS: Record<string, string> = {
  // arrows
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  uparrow: "↑",
  downarrow: "↓",
  to: "→",
  gets: "←",
  mapsto: "↦",
  longrightarrow: "⟶",
  longleftarrow: "⟵",
  // logic / set theory
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  supset: "⊃",
  subseteq: "⊆",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  varnothing: "∅",
  land: "∧",
  lor: "∨",
  lnot: "¬",
  neg: "¬",
  // relations / operators
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  propto: "∝",
  pm: "±",
  mp: "∓",
  times: "×",
  div: "÷",
  cdot: "·",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "•",
  // calculus
  partial: "∂",
  nabla: "∇",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  sqrt: "√",
  // common Greek (lowercase)
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "ϕ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  // common Greek (uppercase)
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

// Match `$\name$` / `$\name $` / a bare `\name` — only when followed by a
// non-letter (so `\theta_1` still rewrites the `\theta`, but `\rightarrowfoo`
// is left alone). We deliberately do not touch `$$ ... $$` display blocks or
// multi-token expressions like `\frac{a}{b}`.
const TEX_INLINE_RE = /\$\\([a-zA-Z]+)\s*\$/g;
const TEX_BARE_RE = /\\([a-zA-Z]+)(?![a-zA-Z])/g;

function texReplace(input: string): string {
  return input
    .replace(TEX_INLINE_RE, (whole, name: string) => {
      const sym = TEX_SYMBOLS[name];
      return sym ?? whole;
    })
    .replace(TEX_BARE_RE, (whole, name: string) => {
      const sym = TEX_SYMBOLS[name];
      return sym ?? whole;
    });
}

// Apply the TeX→Unicode fallback as a rehype pass over text nodes ONLY,
// skipping anything inside `<code>` / `<pre>`. The previous version rewrote
// the whole message string *before* parsing, which mangled code: `cd path\to`
// became `cd path→`, and `\alpha` / `\sum` inside a fenced block were rewritten
// too — and because `CodeBlock`'s `raw` is read back out of the parsed tree,
// the corruption leaked into Copy / Export / the canvas, not just the on-screen
// render. Operating on the hast tree leaves every code node's text intact.
function rehypeTexFallback() {
  return (tree: unknown) => {
    const visit = (node: unknown, inCode: boolean): void => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        tagName?: string;
        value?: string;
        children?: unknown[];
      };
      if (n.type === "text" && !inCode && typeof n.value === "string") {
        n.value = texReplace(n.value);
        return;
      }
      const entersCode =
        n.type === "element" && (n.tagName === "code" || n.tagName === "pre");
      if (Array.isArray(n.children)) {
        for (const child of n.children) visit(child, inCode || entersCode);
      }
    };
    visit(tree, false);
  };
}

// ---------------------------------------------------------------------------
// CodeBlock helper — pull the raw text out of the React tree so the "Copy"
// button gets the un-highlighted source, not a soup of <span>s.
// ---------------------------------------------------------------------------

function hasProps(
  node: unknown,
): node is { props?: { children?: ReactNode; className?: string } } {
  return typeof node === "object" && node !== null && "props" in node;
}

function extractRaw(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractRaw).join("");
  if (hasProps(node)) return extractRaw(node.props?.children);
  return "";
}

// Hoisted out of the render so react-markdown sees a stable `components`
// reference. Inline `{}` literals create a fresh object every render,
// which forces react-markdown to re-mount its component map even when
// nothing else changed — measurable per-token cost on the streaming
// bubble where this component re-renders thousands of times.
const MARKDOWN_PLUGINS_REMARK = [remarkGfm];
const MARKDOWN_PLUGINS_REHYPE = [rehypeTexFallback, rehypeHighlight];
// Same pipeline minus syntax highlighting, used for the still-streaming tail
// of a message. Re-highlighting a growing block on every animation-frame flush
// is the dominant per-token render cost (worst case `highlightAuto` runs every
// grammar for an as-yet-unknown language); skipping it while the block is live
// — then re-rendering the whole message *with* highlighting once streaming
// stops — keeps streaming cheap without changing the settled view. The TeX
// fallback stays (cheap, and keeps inline symbols consistent across the split).
const MARKDOWN_PLUGINS_REHYPE_NOHL = [rehypeTexFallback];

// Open a link from rendered (untrusted) markdown through the OS browser / mail
// client. Mirrors the helper used by Settings / Onboarding / Updates; the
// scheme allow-listing happens at the call site in the `a` component below.
// Decide whether a markdown link href is safe to hand to the OS handler. Model
// output is untrusted: allow only absolute http / https / mailto URLs — the
// schemes `shell:allow-open` grants — and reject javascript:, file:, data:,
// etc. Relative / fragment hrefs don't parse as absolute URLs and return false
// (there's nowhere to navigate inside the chat anyway).
function shouldOpenExternally(href: string | undefined): href is string {
  if (!href) return false;
  let scheme: string;
  try {
    scheme = new URL(href).protocol;
  } catch {
    return false;
  }
  return scheme === "http:" || scheme === "https:" || scheme === "mailto:";
}

const MARKDOWN_COMPONENTS: Components = {
  pre({ children }) {
    // Pull language from the inner <code class="language-xyz">
    const child = Array.isArray(children) ? children[0] : children;
    let language = "";
    if (hasProps(child)) {
      const cls = child.props?.className ?? "";
      const m = /language-(\w+)/.exec(cls);
      if (m) language = m[1];
    }
    const raw = extractRaw(children);
    return (
      <CodeBlock raw={raw} language={language}>
        {children}
      </CodeBlock>
    );
  },
  a({ children, href, node: _node, ...props }) {
    return (
      <a
        href={href}
        rel="noreferrer noopener"
        onClick={(e) => {
          // Model output is untrusted — never let the webview navigate. Open
          // only allow-listed schemes through the OS handler (see
          // `shouldOpenExternally`); ignore everything else.
          e.preventDefault();
          if (shouldOpenExternally(href)) void openExternal(href);
        }}
        {...props}
      >
        {children}
      </a>
    );
  },
};

// `prose-sm` is our base — chat reads in chunks, not articles, so we want
// compact rhythm. The custom theme in tailwind.config.ts dials line-height
// back up and rewires colours / borders to fit the glass surface. The
// first/last resets stop a leading/trailing block adding stray margin (the
// bubble already provides padding).
const PROSE_CLASS = cn(
  "prose prose-sm prose-invert max-w-none",
  "prose-p:first:mt-0 prose-p:last:mb-0",
);

// The bare react-markdown invocation, memoised so an unchanged `content` (+
// `highlight`) skips the whole remark/rehype re-parse when a parent re-renders.
// Renders no wrapper element, so several can sit inside one `prose` container
// and have block margins collapse normally across the boundary — that's what
// lets `StreamingMarkdown` split a message without a visible spacing seam.
const MarkdownBody = memo(function MarkdownBody({
  content,
  highlight,
}: {
  content: string;
  highlight: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_PLUGINS_REMARK}
      rehypePlugins={highlight ? MARKDOWN_PLUGINS_REHYPE : MARKDOWN_PLUGINS_REHYPE_NOHL}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

// `memo` so non-streaming messages skip the entire react-markdown re-parse when
// their parent re-renders for unrelated reasons.
export const Markdown = memo(function Markdown({
  content,
  className,
}: MarkdownProps) {
  return (
    <div className={cn(PROSE_CLASS, className)}>
      <MarkdownBody content={content} highlight />
    </div>
  );
});

// Where to split a still-streaming message into a stable prefix (already-
// complete blocks) and the live tail (the block currently being typed). We cut
// at the last blank line sitting at the TOP level — not inside an open code
// fence — because a blank line there is always a CommonMark block boundary, so
// the prefix renders identically whether or not the tail is appended. Returns
// the prefix length; 0 when there's no safe split yet.
//
// Fence tracking matters two ways: a blank line *inside* a ``` block isn't a
// boundary, and a long code block streams as one growing tail — which the
// no-highlight tail renderer keeps cheap until its closing fence lands and it
// folds into the highlighted, memoised prefix.
export function stableSplit(content: string): number {
  const lines = content.split("\n");
  let inFence = false;
  let fenceChar = "";
  let offset = 0;
  let boundary = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
    }
    offset += line.length + 1; // +1 for the "\n" that split() consumed
    // A top-level blank line closes the preceding block. Never treat the very
    // last line as a boundary — the tail must keep the trailing block so a
    // message ending in "\n\n" doesn't render an empty tail.
    if (!inFence && line.trim() === "" && i < lines.length - 1) {
      boundary = offset;
    }
  }
  return boundary;
}

// Streaming variant of `Markdown`: only the trailing, still-growing block is
// re-parsed per flush; completed blocks render once through the memoised
// `MarkdownBody`, and the live tail skips syntax highlighting. Both halves
// render inside ONE prose container so block spacing across the split matches a
// single document. Once streaming ends, callers swap back to `Markdown`, which
// re-renders the whole message with highlighting — so the settled view is
// identical to what it was before this optimisation.
export const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  className,
}: MarkdownProps) {
  const splitAt = useMemo(() => stableSplit(content), [content]);
  const stable = content.slice(0, splitAt);
  const tail = content.slice(splitAt);
  return (
    <div className={cn(PROSE_CLASS, className)}>
      {stable.length > 0 && <MarkdownBody content={stable} highlight />}
      <MarkdownBody content={tail} highlight={false} />
    </div>
  );
});

// Exposed for unit tests only (`Markdown.test.ts`). These are the security-
// sensitive pure helpers behind H5 (TeX fallback must never touch code) and
// H8 (link scheme allow-list); not part of the public API.
export const __testing = { texReplace, rehypeTexFallback, shouldOpenExternally };
