import { describe, expect, it } from "vitest";
import { diffLines, foldUnchanged, splitHidden, splitLines, type DiffLine } from "./lineDiff";

const render = (old: string, next: string) =>
  diffLines(old, next).map((l) => `${{ same: " ", add: "+", del: "-" }[l.kind]}${l.text}`);

describe("splitLines", () => {
  it("treats the empty string as no lines and drops a trailing newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });

  it("folds CRLF to LF, matching the backend's edit_file", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("marks identical text as unchanged", () => {
    expect(render("a\nb\nc", "a\nb\nc")).toEqual([" a", " b", " c"]);
  });

  it("shows a one-line fix inside context as a -/+ pair", () => {
    expect(render("fn a() {\n  x = 1;\n}", "fn a() {\n  x = 2;\n}")).toEqual([
      " fn a() {",
      "-  x = 1;",
      "+  x = 2;",
      " }",
    ]);
  });

  it("finds insertions and deletions without disturbing the rest", () => {
    expect(render("a\nb\nc", "a\nb\nnew\nc")).toEqual([" a", " b", "+new", " c"]);
    expect(render("a\nb\nc", "a\nc")).toEqual([" a", "-b", " c"]);
  });

  it("treats an empty side as pure addition or removal", () => {
    expect(render("", "x\ny")).toEqual(["+x", "+y"]);
    expect(render("x\ny", "")).toEqual(["-x", "-y"]);
  });

  it("does not report line-ending differences as changes", () => {
    expect(render("a\r\nb\r\n", "a\nb\n")).toEqual([" a", " b"]);
  });

  // Removing the snippet's final line break makes edit_file join the file's
  // next line onto it (`// check auth` + `if (!isAdmin) …` → one comment),
  // so it must never read as "no change".
  it("shows a removed trailing line break as a change", () => {
    expect(diffLines("// check auth\n", "// check auth")).toEqual([
      { kind: "del", text: "// check auth" },
      { kind: "add", text: "// check auth", noEol: true },
    ]);
  });

  it("shows an added trailing line break as a change", () => {
    expect(diffLines("x", "x\n")).toEqual([
      { kind: "del", text: "x", noEol: true },
      { kind: "add", text: "x" },
    ]);
  });

  it("still matches the lines both sides share when only the final break differs", () => {
    expect(diffLines("a\nb\n", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "add", text: "c", noEol: true },
    ]);
  });

  it("adds no marker when both sides agree about the final break", () => {
    expect(diffLines("x\ny", "x\ny\nz")).toEqual([
      { kind: "same", text: "x" },
      { kind: "same", text: "y" },
      { kind: "add", text: "z" },
    ]);
  });

  it("diffs one changed line in a long snippet as one pair, not a rewrite", () => {
    const lines = Array.from({ length: 700 }, (_, i) => `l${i}`);
    const edited = [...lines];
    edited[350] = "changed";
    const out = diffLines(lines.join("\n"), edited.join("\n"));
    expect(out.filter((l) => l.kind !== "same")).toEqual([
      { kind: "del", text: "l350" },
      { kind: "add", text: "changed" },
    ]);
    expect(out).toHaveLength(701);
  });

  it("falls back to remove-all/add-all rather than building a huge table", () => {
    const left = Array.from({ length: 700 }, (_, i) => `l${i}`).join("\n");
    const right = Array.from({ length: 700 }, (_, i) => `r${i}`).join("\n");
    const out = diffLines(left, right);
    expect(out).toHaveLength(1400);
    expect(out.slice(0, 700).every((l) => l.kind === "del")).toBe(true);
    expect(out.slice(700).every((l) => l.kind === "add")).toBe(true);
  });
});

describe("foldUnchanged", () => {
  const same = (n: number, from = 0): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "same", text: `s${from + i}` }));

  it("keeps three lines of context either side of a change and folds the rest", () => {
    const lines: DiffLine[] = [
      ...same(10),
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
      ...same(10, 10),
    ];
    expect(foldUnchanged(lines)).toEqual([
      { kind: "fold", count: 7 },
      ...same(3, 7),
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
      ...same(3, 10),
      { kind: "fold", count: 7 },
    ]);
  });

  it("leaves a short run between two changes whole", () => {
    const lines: DiffLine[] = [
      { kind: "del", text: "a" },
      ...same(7),
      { kind: "add", text: "b" },
    ];
    expect(foldUnchanged(lines)).toEqual(lines);
  });

  it("leaves a diff with no change in it whole", () => {
    const lines = same(50);
    expect(foldUnchanged(lines)).toBe(lines);
  });
});

describe("splitHidden", () => {
  it("leaves ordinary text, tabs and line breaks alone", () => {
    expect(splitHidden("let a = 1;\tb\r\n")).toEqual(["let a = 1;\tb\r\n"]);
  });

  // "Trojan Source": a right-to-left override makes the line display in a
  // different order from the one it runs in.
  it("sets bidi controls and zero-width characters apart", () => {
    expect(splitHidden("if (admin\u202E) {\u200B}")).toEqual([
      "if (admin",
      { hidden: "U+202E" },
      ") {",
      { hidden: "U+200B" },
      "}",
    ]);
  });
});
