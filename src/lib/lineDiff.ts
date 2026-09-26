/**
 * Line diff for the workspace approval card.
 *
 * `edit_file` arrives as an `old_text` / `new_text` pair; showing those as
 * two escaped JSON strings hides what actually changes when the snippet is
 * ten lines of context around a one-line fix. A classic LCS line diff turns
 * the pair into the familiar `-`/`+` view, and the inputs are approval-sized
 * snippets, so the quadratic table is cheap. A pathological pair — two huge
 * texts that differ throughout — falls back to "everything removed,
 * everything added" instead of allocating a multi-megabyte table on the
 * render thread.
 */

/** `noEol` marks the last line of a side that doesn't end in a line break —
 *  set only when the other side does, which is the one time it changes the
 *  result: whatever follows the snippet in the file joins (or leaves) that
 *  line. */
export type DiffLine = { kind: "same" | "add" | "del"; text: string; noEol?: boolean };

/** Largest `old × new` line-count product the LCS table is built for. */
const MAX_CELLS = 400_000;

/** Split on `\n` with `\r\n` folded in first — the backend's `edit_file`
 *  matches the same way — and without a phantom empty line for a trailing
 *  newline. The empty string is zero lines, not one empty one. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  // `splitLines` forgets whether the text ended in a line break, so on text
  // alone `x\n` → `x` diffs as "no change" — yet `edit_file` applying it
  // joins the file's next line onto `x`. When the two sides disagree about
  // that final break, compare each line *with* its terminator: the side
  // without one then has a last line that matches nothing, and the change
  // shows as a `-`/`+` pair. When they agree, text alone is exact — and
  // keeps an ordinary snippet edit free of terminator noise.
  const oldEol = oldText.endsWith("\n");
  const newEol = newText.endsWith("\n");
  const eolDiffers = oldEol !== newEol;
  const keys = (lines: string[], eol: boolean) =>
    eolDiffers ? lines.map((l, k) => (k < lines.length - 1 || eol ? `${l}\n` : l)) : lines;
  const ka = keys(a, oldEol);
  const kb = keys(b, newEol);
  const line = (kind: DiffLine["kind"], text: string, last: boolean, eol: boolean): DiffLine =>
    eolDiffers && last && !eol ? { kind, text, noEol: true } : { kind, text };
  const del = (k: number) => line("del", a[k], k === n - 1, oldEol);
  const add = (k: number) => line("add", b[k], k === m - 1, newEol);

  // Lines both sides share at the start and at the end are unchanged
  // whatever happens between them, so the table only has to cover the part
  // that differs: a 700-line snippet with one edited line then diffs as one
  // `-`/`+` pair rather than tripping the "all removed, all added" fallback.
  let pre = 0;
  while (pre < n && pre < m && ka[pre] === kb[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && ka[n - 1 - suf] === kb[m - 1 - suf]) suf++;
  const rows = n - suf - pre;
  const cols = m - suf - pre;

  const out: DiffLine[] = [];
  for (let k = 0; k < pre; k++) out.push({ kind: "same", text: a[k] });
  if (rows * cols > MAX_CELLS) {
    for (let k = pre; k < pre + rows; k++) out.push(del(k));
    for (let k = pre; k < pre + cols; k++) out.push(add(k));
  } else {
    // lcs[i][j] = length of the longest common subsequence of the middle
    // parts from a[pre + i] and b[pre + j] on, filled from the bottom-right
    // so the walk below reads forwards.
    const w = cols + 1;
    const lcs = new Uint32Array((rows + 1) * w);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lcs[i * w + j] =
          ka[pre + i] === kb[pre + j]
            ? lcs[(i + 1) * w + j + 1] + 1
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (ka[pre + i] === kb[pre + j]) {
        out.push({ kind: "same", text: a[pre + i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        // Emitting the removal first keeps `-` above `+` for a replaced line.
        out.push(del(pre + i));
        i++;
      } else {
        out.push(add(pre + j));
        j++;
      }
    }
    for (; i < rows; i++) out.push(del(pre + i));
    for (; j < cols; j++) out.push(add(pre + j));
  }
  for (let k = n - suf; k < n; k++) out.push({ kind: "same", text: a[k] });
  return out;
}

/** A row of the diff as the card shows it: a line, or a fold standing in
 *  for a run of unchanged lines. */
export type DiffRow = DiffLine | { kind: "fold"; count: number };

/**
 * Fold every run of unchanged lines down to `context` lines either side of
 * a change, the way a unified diff does, so the card leads with what
 * changes. Unfolded, a snippet padded with a few hundred lines of context
 * pushed its one real change past the rows the card shows. A diff with no
 * change in it is left whole.
 */
export function foldUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  if (lines.every((l) => l.kind === "same")) return lines;
  const out: DiffRow[] = [];
  let k = 0;
  while (k < lines.length) {
    if (lines[k].kind !== "same") {
      out.push(lines[k]);
      k++;
      continue;
    }
    let end = k;
    while (end < lines.length && lines[end].kind === "same") end++;
    // Context after the change above (none at the very start) and before
    // the change below (none at the very end).
    const head = k === 0 ? 0 : context;
    const tail = end === lines.length ? 0 : context;
    // Folding a single line would save nothing.
    if (end - k > head + tail + 1) {
      out.push(...lines.slice(k, k + head));
      out.push({ kind: "fold", count: end - k - head - tail });
      out.push(...lines.slice(end - tail, end));
    } else {
      out.push(...lines.slice(k, end));
    }
    k = end;
  }
  return out;
}
