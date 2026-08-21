/* Renders a chat message into a shareable PNG on a 2D canvas.
 *
 * Deliberately not a DOM screenshot: html2canvas & co. are a new dependency
 * and can't pull anything over the network under the window CSP anyway. The
 * bubble is drawn from primitives, and markdown is rendered as the plain
 * text it was written as. */

/** Logical (CSS-pixel) width of the card; the bitmap is `SCALE`× that. */
const WIDTH = 1000;
const SCALE = 2;
const PAD = 44;
const BUBBLE_PAD_X = 26;
const BUBBLE_PAD_Y = 20;
const FONT_SIZE = 19;
const LINE_HEIGHT = 29;
const LABEL_SIZE = 13;
/** Long replies would otherwise produce a mile-high PNG no one can read. */
const MAX_LINES = 48;
/** Matches the app's Tailwind `font-sans` stack so the image looks like the
 *  window it came from (Inter when installed, system UI font otherwise). */
const FONT_STACK = '"Inter", ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

export interface ShareImage {
  dataUrl: string;
  blob: Blob;
}

/**
 * Greedy word-wrap. `measure` is injected so the wrapping is testable
 * without a canvas — the renderer passes `ctx.measureText(s).width`.
 *
 * Explicit newlines are kept (an empty paragraph yields an empty line), runs
 * of spaces survive the split/join so indentation isn't flattened, and a
 * single word wider than the line (a long URL) is split by character.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    // Tracks "a word has landed on this line" rather than testing `line !==
    // ""` — a run of leading spaces splits into empty words, and those have
    // to rejoin as the indentation they were.
    let started = false;
    for (const word of paragraph.split(" ")) {
      if (measure(word) > maxWidth) {
        if (line !== "") out.push(line);
        const pieces = hardSplit(word, maxWidth, measure);
        out.push(...pieces.slice(0, -1));
        line = pieces[pieces.length - 1] ?? "";
        started = true;
        continue;
      }
      const candidate = started ? `${line} ${word}` : word;
      if (started && measure(candidate) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
      started = true;
    }
    out.push(line);
  }
  return out;
}

function hardSplit(
  word: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur !== "" && measure(cur + ch) > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Per-corner rounded rectangle path — the bubble squares off one top corner
 *  the same way the chat bubbles do (`rounded-tr-lg` / `rounded-tl-lg`). */
function bubblePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  [tl, tr, br, bl]: [number, number, number, number],
) {
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.arcTo(x + w, y, x + w, y + h, tr);
  ctx.arcTo(x + w, y + h, x, y + h, br);
  ctx.arcTo(x, y + h, x, y, bl);
  ctx.arcTo(x, y, x + w, y, tl);
  ctx.closePath();
}

interface Palette {
  bgFrom: string;
  bgTo: string;
  bubble: string;
  bubbleBorder: string;
  text: string;
  muted: string;
}

const DARK: Palette = {
  bgFrom: "#12151c",
  bgTo: "#0a0c11",
  bubble: "rgba(255,255,255,0.075)",
  bubbleBorder: "rgba(255,255,255,0.12)",
  text: "#e9ebf1",
  muted: "rgba(233,235,241,0.45)",
};

const LIGHT: Palette = {
  bgFrom: "#ffffff",
  bgTo: "#eef0f4",
  bubble: "rgba(15,17,23,0.05)",
  bubbleBorder: "rgba(15,17,23,0.10)",
  text: "#14161c",
  muted: "rgba(20,22,28,0.5)",
};

/** Draw `text` as a chat bubble and hand back both a preview data URL and a
 *  PNG blob (the clipboard wants the blob, the `<img>` wants the URL). */
export async function renderShareImage(opts: {
  role: "user" | "assistant";
  text: string;
  dark: boolean;
}): Promise<ShareImage> {
  const palette = opts.dark ? DARK : LIGHT;
  const isUser = opts.role === "user";
  const maxTextWidth = WIDTH - PAD * 2 - BUBBLE_PAD_X * 2;

  const measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) throw new Error("canvas 2d context unavailable");
  measureCtx.font = `${FONT_SIZE}px ${FONT_STACK}`;

  let lines = wrapLines(opts.text.trim(), maxTextWidth, (s) =>
    measureCtx.measureText(s).width,
  );
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES), "…"];

  const textWidth = Math.max(
    240,
    ...lines.map((l) => Math.ceil(measureCtx.measureText(l).width)),
  );
  const bubbleWidth = Math.min(maxTextWidth, textWidth) + BUBBLE_PAD_X * 2;
  const bubbleHeight = lines.length * LINE_HEIGHT + BUBBLE_PAD_Y * 2;
  const labelY = PAD + LABEL_SIZE;
  const bubbleY = labelY + 14;
  const footerY = bubbleY + bubbleHeight + 34;
  const height = footerY + PAD - LABEL_SIZE + 4;

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * SCALE;
  canvas.height = Math.round(height) * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(SCALE, SCALE);

  const bg = ctx.createLinearGradient(0, 0, WIDTH, height);
  bg.addColorStop(0, palette.bgFrom);
  bg.addColorStop(1, palette.bgTo);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, height);

  const bubbleX = isUser ? WIDTH - PAD - bubbleWidth : PAD;

  ctx.font = `500 ${LABEL_SIZE}px ${FONT_STACK}`;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = isUser ? "right" : "left";
  ctx.fillText(isUser ? "Prompt" : "AI Response", isUser ? WIDTH - PAD : PAD, labelY);

  bubblePath(ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight,
    isUser ? [24, 8, 24, 24] : [8, 24, 24, 24]);
  ctx.fillStyle = palette.bubble;
  ctx.fill();
  ctx.strokeStyle = palette.bubbleBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = `${FONT_SIZE}px ${FONT_STACK}`;
  ctx.fillStyle = palette.text;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => {
    ctx.fillText(
      line,
      bubbleX + BUBBLE_PAD_X,
      bubbleY + BUBBLE_PAD_Y + (i + 1) * LINE_HEIGHT - 8,
    );
  });

  ctx.font = `500 ${LABEL_SIZE}px ${FONT_STACK}`;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "right";
  ctx.fillText("Shared from Loach", WIDTH - PAD, footerY);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("could not encode the image");
  return { dataUrl: canvas.toDataURL("image/png"), blob };
}
