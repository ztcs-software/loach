/**
 * Minimal fenced-code-block extraction, used to keep the Code Canvas in sync
 * with a code block that is still streaming.
 *
 * We deliberately do NOT pull in a full Markdown/AST parser here: the only
 * thing the live canvas needs is "the source text of a fenced block in this
 * message, even if its closing fence hasn't arrived yet". A single forward
 * line scan covers that — and crucially handles the unterminated fence that
 * exists for the whole duration of a streaming code block.
 *
 * Supports both ``` and ~~~ fences, indented fences, and the info string
 * (language) on the opening fence. Closing fences must use the same fence
 * character and be at least as long as the opener (CommonMark), and carry no
 * info string — `openingFence` / `closesFence`, which the streaming
 * renderer's split (`stableSplit`) shares. Nested fences are not handled —
 * vanishingly rare in practice and not worth the complexity for a
 * live-preview helper.
 */
export interface ExtractedBlock {
  code: string;
  language: string | null;
}

/** An open fence: its character and how long a run opened it. */
export interface Fence {
  char: string;
  length: number;
}

const OPEN_FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

/** The fence `line` opens, with its info string, or null. */
export function openingFence(line: string): (Fence & { info: string }) | null {
  const m = OPEN_FENCE.exec(line);
  return m ? { char: m[1][0], length: m[1].length, info: m[2].trim() } : null;
}

/** Does `line` close `open`? Only a run of the same character, at least as
 *  long, with nothing after it: a "```js" line inside a "````markdown" block
 *  is that block's content, not its end. */
export function closesFence(line: string, open: Fence): boolean {
  const m = CLOSE_FENCE.exec(line);
  return !!m && m[1][0] === open.char && m[1].length >= open.length;
}

/**
 * Every fenced code block in `md`, in order. A fence that is open but never
 * closed (the common case mid-stream) counts as the last block and yields
 * whatever has been emitted so far.
 */
export function codeBlocks(md: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  let open: Fence | null = null;
  let language: string | null = null;
  let buf: string[] = [];

  for (const line of md.split("\n")) {
    if (!open) {
      const fence = openingFence(line);
      if (fence) {
        open = fence;
        language = fence.info ? fence.info.split(/\s+/)[0].toLowerCase() : null;
        buf = [];
      }
      continue;
    }
    if (closesFence(line, open)) {
      blocks.push({ code: buf.join("\n"), language });
      open = null;
    } else {
      buf.push(line);
    }
  }

  // Unterminated fence — what we have IS the (still-growing) last block.
  if (open) {
    blocks.push({ code: buf.join("\n"), language });
  }
  return blocks;
}

/** The last fenced code block in `md`, or null if there isn't one. */
export function lastCodeBlock(md: string): ExtractedBlock | null {
  return codeBlocks(md).at(-1) ?? null;
}
