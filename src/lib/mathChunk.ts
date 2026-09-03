/**
 * Everything KaTeX, behind one module so it lands in exactly one lazy chunk.
 *
 * The two stylesheets must load in this order — `katex.css` overrides rules
 * from `katex.min.css` at equal specificity — which is only guaranteed if a
 * single module imports both. Separate `import()` calls from `math.ts` would
 * be separate chunks with no ordering guarantee between their stylesheets.
 *
 * Nothing else in the app may import this module statically; that would pull
 * KaTeX back into the baseline bundle. `math.ts` reaches it via `import()`.
 */

import "katex/dist/katex.min.css";
import "@/styles/katex.css";

export { default as remarkMath } from "remark-math";
export { default as rehypeKatex } from "rehype-katex";
