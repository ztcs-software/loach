import { describe, expect, it } from "vitest";
import { diffLines, splitLines } from "./lineDiff";

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

  it("falls back to remove-all/add-all rather than building a huge table", () => {
    const left = Array.from({ length: 700 }, (_, i) => `l${i}`).join("\n");
    const right = Array.from({ length: 700 }, (_, i) => `r${i}`).join("\n");
    const out = diffLines(left, right);
    expect(out).toHaveLength(1400);
    expect(out.slice(0, 700).every((l) => l.kind === "del")).toBe(true);
    expect(out.slice(700).every((l) => l.kind === "add")).toBe(true);
  });
});
