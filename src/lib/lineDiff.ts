/**
 * Line diff for the workspace approval card.
 *
 * `edit_file` arrives as an `old_text` / `new_text` pair; showing those as
 * two escaped JSON strings hides what actually changes when the snippet is
 * ten lines of context around a one-line fix. A classic LCS line diff turns
 * the pair into the familiar `-`/`+` view, and the inputs are approval-sized
 * snippets, so the quadratic table is cheap. A pathological pair — two huge
 * texts with nothing in common — falls back to "everything removed,
 * everything added" instead of allocating a multi-megabyte table on the
 * render thread.
 */

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

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
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and
  // b[j..], filled from the bottom-right so the walk below reads forwards.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      // Emitting the removal first keeps `-` above `+` for a replaced line.
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "del", text: a[i] });
  for (; j < m; j++) out.push({ kind: "add", text: b[j] });
  return out;
}
