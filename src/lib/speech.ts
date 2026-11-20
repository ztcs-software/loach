import { closesFence, openingFence, type Fence } from "@/lib/codeBlocks";
import { normalizeMath } from "@/lib/math";

// Block-level markup, matched per line.
const BLANK_OR_RULE = /^\s*$|^\s{0,3}([-*_])(\s*\1){2,}\s*$|^\s*=+\s*$/;
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S/;
const TABLE_DELIMITER = /^(?=.*\|)(?=.*-)[\s|:-]+$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const BLOCKQUOTE = /^(\s*>)+\s?/;
const HEADING = /^\s{0,3}#{1,6}(\s+|$)/;
const BULLET = /^\s*[-*+]\s+(\[[ xX]\]\s+)?/;
const ORDERED = /^\s*\d{1,9}[.)]\s+/;

// Private-use characters around an inline code span's index while the rest
// of its line is stripped.
const CODE_OPEN = String.fromCharCode(0xe000);
const CODE_CLOSE = String.fromCharCode(0xe001);
const CODE_SLOT = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g");

/** Inline markup stripped down to the words a voice should say. Inline code
 *  is set aside first and read as written: stripped with the rest,
 *  `Vec<String>` lost its type as an HTML tag and `C:\Users` its slash. */
function inlineText(line: string): string {
  const code: string[] = [];
  return line
    .replace(/(`+)(.+?)\1/g, (_, _ticks: string, span: string) => `${CODE_OPEN}${code.push(span) - 1}${CODE_CLOSE}`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    // `normalizeMath` has turned every vetted inline formula into `$$…$$`,
    // and left prices like "$5" alone for the voice to read as money.
    .replace(/\$\$(.+?)\$\$/g, (_, tex: string) => tex.replace(/[\\{}]/g, " "))
    .replace(/([^\s*])\*+|\*+(?=[^\s*])/g, "$1")
    // Underscores only at word edges, so `snake_case` survives.
    .replace(/(^|\W)_+(?=\S)|(\S)_+(?=\W|$)/g, "$1$2")
    .replace(/~~|\\/g, "")
    .replace(CODE_SLOT, (_, i: string) => code[Number(i)])
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest chunk, in characters. Chromium's online voices end an utterance
 *  after about 15 seconds with no `end` event — some 200 characters at a
 *  usual rate — so a long paragraph is spoken a few sentences at a time. */
const MAX_CHUNK = 200;

/** `text` in pieces of at most [`MAX_CHUNK`] characters, cut between
 *  sentences, or between words inside a sentence too long on its own. */
function bySentence(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const pieces: string[] = [];
  let current = "";
  const add = (part: string) => {
    if (current && current.length + 1 + part.length > MAX_CHUNK) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current} ${part}` : part;
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length <= MAX_CHUNK) add(sentence);
    else for (const word of sentence.split(" ")) add(word);
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * A Markdown reply as it should be read aloud, in the chunks it's spoken in:
 * one per paragraph, heading, list item or table row, so the voice pauses
 * where the eye would — a long one a few sentences at a time.
 *
 * Code blocks and display math are skipped — spelled out symbol by symbol
 * they're noise. Inline code and inline math keep their text. A line scan
 * rather than a Markdown parser, for the same reason as `codeBlocks`: it's
 * all a voice needs.
 */
export function speechChunks(md: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join(" ").trim();
    if (text) chunks.push(...bySentence(text));
    current = [];
  };
  let fence: Fence | null = null;
  let displayMath = false;

  for (const raw of normalizeMath(md).split("\n")) {
    let line = raw.replace(BLOCKQUOTE, "");
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (displayMath) {
      if (line.trim() === "$$") displayMath = false;
      continue;
    }
    // A fence may open on a list item's own line (`1. ```bash`).
    const opened = openingFence(line.replace(BULLET, "").replace(ORDERED, ""));
    if (opened || line.trim() === "$$") {
      flush();
      fence = opened;
      displayMath = !opened;
      continue;
    }
    if (BLANK_OR_RULE.test(line) || LINK_DEFINITION.test(line) || TABLE_DELIMITER.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING.test(line);
    const row = TABLE_ROW.test(line);
    if (heading || row || BULLET.test(line) || ORDERED.test(line)) flush();
    line = line.replace(HEADING, "").replace(BULLET, "");
    if (row) {
      line = line
        .split("|")
        .map((cell) => inlineText(cell))
        .filter(Boolean)
        .join(", ");
    }
    current.push(inlineText(line));
    if (heading || row) flush();
  }
  flush();
  return chunks;
}
