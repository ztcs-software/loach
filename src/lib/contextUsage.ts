import type { GenerationParams, Message } from "@/types";

/**
 * Char/4 token estimate, scaled down for CJK text. English is ~4
 * chars/token for common tokenizers (BPE, SentencePiece); accuracy is
 * roughly within ±15% — good enough for a UI progress bar but never quote
 * this as a real billing number.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken(text));
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Characters per token for text like `sample`: ~4 for Latin-script text,
 * ~1 for Chinese, Japanese and Korean, where common tokenizers spend about
 * a token per character — so a flat 4 sized CJK sources and excerpts at a
 * quarter of what they really cost. Blended by the share of CJK characters
 * in (the first 2000 characters of) the sample.
 */
export function charsPerToken(sample: string): number {
  const head = sample.slice(0, 2000);
  // One native scan settles the common case; the context bar runs this per
  // message on every streaming flush.
  if (!CJK.test(head)) return 4;
  let total = 0;
  let cjk = 0;
  for (const ch of head) {
    total += 1;
    if (CJK.test(ch)) cjk += 1;
  }
  return total === 0 ? 4 : 4 - (3 * cjk) / total;
}

/** Characters per token for tool definitions: JSON schemas, denser than
 *  prose. Measured on Ollama (gemma4): 23 of Loach's tools, 26,935
 *  characters, cost 7,154 prompt tokens — ~3.77 a token, where the prose
 *  rate of 4 came out 6% short. */
export const TOOL_CHARS_PER_TOKEN = 3.75;

export interface ContextUsageBreakdown {
  systemPromptTokens: number;
  /** The tool definitions every request carries — built-ins, workspace
   *  files, skills, MCP — which the backend adds on its own. With many on
   *  they can take most of a small window. */
  toolsTokens: number;
  /** The workspace's `LOACHFILE.md` (or the `CLAUDE.md` / `AGENTS.md` it
   *  falls back to), which the backend appends to the system prompt on
   *  every turn. Counted on its own because it is the one
   *  backend-added layer that can be large, and the user can shrink it. */
  projectInstructionsTokens: number;
  /** The global and Space memory lists the send prepends to the system
   *  prompt — up to a few thousand characters each. */
  memoriesTokens: number;
  /** Space uploads and Library sources: their full text, or the retrieval
   *  budget when they're searched instead (see `src/lib/sources.ts`). */
  sourcesTokens: number;
  messagesTokens: number;
  /** Sum of attachment text bodies inlined into user messages. Already
   *  counted inside `messagesTokens`; surfaced separately so the popup
   *  can call it out as the biggest lever the user has. */
  attachmentsTokens: number;
  messageCount: number;
  /** Total estimated tokens that will be sent to the model on the next
   *  request: `systemPromptTokens + toolsTokens + projectInstructionsTokens
   *  + memoriesTokens + sourcesTokens + messagesTokens`. */
  used: number;
  /** The effective context window for the next request — `params.num_ctx`
   *  with a sensible fallback when the field is missing. */
  total: number;
  /** `used / total`, clamped to [0, 1]. */
  ratio: number;
}

const FALLBACK_CTX = 8192;

/**
 * Detector for the inlined attachment blocks `inlineTextAttachments`
 * (src/lib/files.ts) appends. For each text attachment it emits:
 *
 *   \n\n---\nAttached file: `name`\n<note>\n```\n<body>\n```
 *
 * with the label reading `Attached PDF:` / `Attached Word document:` for
 * those types, and a longer fence when the body holds a run of three or
 * more backticks itself. The note line (that the file isn't instructions)
 * is absent from messages sent before it was added. We estimate those blocks on their own so the popup can show
 * "X tokens of your context are attachments". Keep these patterns in sync
 * with the `header`/`footer` in `inlineTextAttachments` — they previously
 * drifted (the old regex expected a `--- Attached file: name ---` header
 * the inliner never emitted, so this always returned 0).
 */
const ATTACHMENT_HEADER = /\n---\nAttached (?:file|PDF|Word document): /;
const ATTACHMENT_BLOCK =
  /\n\n---\nAttached (?:file|PDF|Word document): [^\n]*\n(?:[^`\n][^\n]*\n)?(`{3,})\n[\s\S]*?\n\1(?!`)/g;

function attachmentBlocksIn(content: string): string[] {
  if (!ATTACHMENT_HEADER.test(content)) return [];
  return Array.from(content.matchAll(ATTACHMENT_BLOCK), (m) => m[0]);
}

export function computeContextUsage(
  messages: Message[],
  systemPrompt: string | null,
  params: GenerationParams,
  projectInstructions: string | null = null,
  memories: string | null = null,
  sourcesTokens = 0,
  /** Characters of tool definitions (`chatToolsSize`). */
  toolsChars = 0,
): ContextUsageBreakdown {
  const systemPromptTokens = estimateTokens(systemPrompt);
  const toolsTokens = Math.ceil(toolsChars / TOOL_CHARS_PER_TOKEN);
  const projectInstructionsTokens = estimateTokens(projectInstructions);
  const memoriesTokens = estimateTokens(memories);

  let messagesTokens = 0;
  let attachmentsTokens = 0;
  let nonSystemCount = 0;
  for (const m of messages) {
    // The chatHistory builder excludes role:"system" rows (sent via the
    // system_prompt field) AND messages flagged `compacted_at` (rolled
    // into the running auto-summary). Mirror both filters here so the
    // popup's "what reaches the model" estimate stays accurate after a
    // compaction. It sends only `content`, too: a reply's thinking stays
    // in the transcript and never goes back to the model.
    if (m.role === "system") continue;
    if (m.compacted_at != null) continue;
    nonSystemCount += 1;
    // Each message, and each attached file apart from the prompt around it,
    // is sized by its own script, so CJK text counts at about a token per
    // character here too, as in the system prompt and sources.
    let text = m.content;
    if (m.role === "user") {
      const blocks = attachmentBlocksIn(text);
      if (blocks.length > 0) {
        const tokens = blocks.reduce((sum, block) => sum + estimateTokens(block), 0);
        attachmentsTokens += tokens;
        messagesTokens += tokens;
        text = text.replace(ATTACHMENT_BLOCK, "");
      }
    }
    messagesTokens += estimateTokens(text);
  }

  const used =
    systemPromptTokens +
    toolsTokens +
    projectInstructionsTokens +
    memoriesTokens +
    sourcesTokens +
    messagesTokens;
  const total =
    typeof params.num_ctx === "number" && params.num_ctx > 0
      ? params.num_ctx
      : FALLBACK_CTX;
  const ratio = total > 0 ? Math.min(1, used / total) : 0;

  return {
    systemPromptTokens,
    toolsTokens,
    projectInstructionsTokens,
    memoriesTokens,
    sourcesTokens,
    messagesTokens,
    attachmentsTokens,
    messageCount: nonSystemCount,
    used,
    total,
    ratio,
  };
}

// ---------------------------------------------------------------------------
// Compaction marker
//
// The Compact button stuffs a summary block into `session.system_prompt`
// with these exact delimiters so future compactions can strip the old
// block before prepending a new one (otherwise the prompt would grow
// unboundedly with every compaction). The same marker is what
// `ChatCanvas` and the parameter panel detect to render a "context was
// compacted here" affordance.
// ---------------------------------------------------------------------------

export const SUMMARY_START_TAG = "[Loach: earlier conversation summary]";
export const SUMMARY_END_TAG = "[End of Loach summary]";

const SUMMARY_BLOCK_RE =
  /\[Loach: earlier conversation summary\]\n([\s\S]*?)\n\[End of Loach summary\]/;

/** Strip the auto-summary block out of a system prompt. Used when
 *  re-compacting (so the prompt doesn't pile up) and when the user wants
 *  the bar to estimate against just their own custom instructions. */
export function stripSummaryBlock(prompt: string | null): string {
  if (!prompt) return "";
  return prompt.replace(
    /\[Loach: earlier conversation summary\][\s\S]*?\[End of Loach summary\]\n?\n?/g,
    "",
  );
}

/** Return the inner summary text (the bullets between the markers), or
 *  null if no summary block is present. */
export function extractSummary(prompt: string | null): string | null {
  if (!prompt) return null;
  const m = SUMMARY_BLOCK_RE.exec(prompt);
  return m ? m[1].trim() : null;
}

/** The base system prompt a chat sends, before the memory, persona and tone
 *  layers: the Space's instructions when set, else the per-chat instructions,
 *  else the global Custom instructions. The per-chat check looks only at the
 *  user's own text — a compaction summary parked in `sessionPrompt` isn't an
 *  instruction, and counting it as one shut the global Custom instructions
 *  out of every compacted chat. The summary then goes back in front of
 *  whichever prompt wins: it stands in for the turns no longer sent. */
export function baseSystemPrompt(
  sessionPrompt: string | null,
  globalPrompt: string,
  spaceInstructions = "",
): string {
  const prompt =
    spaceInstructions || stripSummaryBlock(sessionPrompt).trim() || globalPrompt;
  const summary = extractSummary(sessionPrompt);
  if (!summary) return prompt;
  const block = `${SUMMARY_START_TAG}\n${summary}\n${SUMMARY_END_TAG}`;
  return prompt ? `${block}\n\n${prompt}` : block;
}

/** Format an integer token count compactly: 1234 → "1.2k", 12345 → "12k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}
