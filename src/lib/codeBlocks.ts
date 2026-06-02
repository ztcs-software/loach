/**
 * Minimal fenced-code-block extraction, used to keep the Code Canvas in sync
 * with a code block that is still streaming.
 *
 * We deliberately do NOT pull in a full Markdown/AST parser here: the only
 * thing the live canvas needs is "the source text of the last fenced block in
 * this message, even if its closing fence hasn't arrived yet". A single
 * forward line scan covers that — and crucially handles the unterminated
 * fence that exists for the whole duration of a streaming code block.
 *
 * Supports both ``` and ~~~ fences, indented fences, and the info string
 * (language) on the opening fence. Closing fences must use the same fence
 * character and be at least as long as the opener (CommonMark), and carry no
 * info string. Nested fences are not handled — vanishingly rare in practice
 * and not worth the complexity for a live-preview helper.
 */
export interface ExtractedBlock {
  code: string;
  language: string | null;
}

const OPEN_FENCE = /^(\s*)([`~]{3,})(.*)$/;
const CLOSE_FENCE = /^(\s*)([`~]{3,})\s*$/;

/**
 * Return the last fenced code block in `md`, or null if there isn't one. A
 * fence that is open but never closed (the common case mid-stream) counts as
 * the last block and yields whatever has been emitted so far.
 */
export function lastCodeBlock(md: string): ExtractedBlock | null {
  const lines = md.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let language: string | null = null;
  let buf: string[] = [];
  let last: ExtractedBlock | null = null;

  for (const line of lines) {
    if (!inFence) {
      const m = OPEN_FENCE.exec(line);
      if (m) {
        inFence = true;
        fenceChar = m[2][0];
        fenceLen = m[2].length;
        const info = m[3].trim();
        language = info ? info.split(/\s+/)[0].toLowerCase() : null;
        buf = [];
      }
      continue;
    }
    const cm = CLOSE_FENCE.exec(line);
    if (cm && cm[2][0] === fenceChar && cm[2].length >= fenceLen) {
      last = { code: buf.join("\n"), language };
      inFence = false;
    } else {
      buf.push(line);
    }
  }

  // Unterminated fence — what we have IS the (still-growing) last block.
  if (inFence) {
    last = { code: buf.join("\n"), language };
  }
  return last;
}
