import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { CodeBlock } from "./CodeBlock";
import { cn } from "@/lib/utils";

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

function preprocessTex(input: string): string {
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

export function Markdown({ content, className }: MarkdownProps) {
  const prepared = preprocessTex(content);
  return (
    <div
      className={cn(
        // `prose-sm` is our base — chat reads in chunks, not articles, so
        // we want compact rhythm. The custom theme in tailwind.config.ts
        // dials line-height back up and rewires colours / borders to fit
        // the glass surface.
        "prose prose-sm prose-invert max-w-none",
        // Make sure first / last block don't add stray top / bottom margin
        // — the message bubble already provides padding.
        "prose-p:first:mt-0 prose-p:last:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
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
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}
