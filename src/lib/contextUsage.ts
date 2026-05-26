import type { GenerationParams, Message } from "@/types";

/**
 * Char/4 token estimate. English is ~4 chars/token for common tokenizers
 * (BPE, SentencePiece); accuracy is roughly within ±15% — good enough for
 * a UI progress bar but never quote this as a real billing number.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ContextUsageBreakdown {
  systemPromptTokens: number;
  messagesTokens: number;
  /** Sum of attachment text bodies inlined into user messages. Already
   *  counted inside `messagesTokens`; surfaced separately so the popup
   *  can call it out as the biggest lever the user has. */
  attachmentsTokens: number;
  messageCount: number;
  /** Total estimated tokens that will be sent to the model on the next
   *  request: `systemPromptTokens + messagesTokens`. */
  used: number;
  /** The effective context window for the next request — `params.num_ctx`
   *  with a sensible fallback when the field is missing. */
  total: number;
  /** `used / total`, clamped to [0, 1]. */
  ratio: number;
}

const FALLBACK_CTX = 8192;

/**
 * Crude detector for the inlined attachment block — `inlineTextAttachments`
 * wraps every text attachment in `\`\`\`<lang>\n…\n\`\`\`` with a leading
 * `--- Attached file: name ---` header. We sum the length of those blocks
 * so the popup can show "X tokens of your context are attachments".
 */
const ATTACHMENT_HEADER = /^--- Attached file: /m;
const ATTACHMENT_BLOCK =
  /--- Attached file: [^\n]+ ---\n```[a-zA-Z0-9_+-]*\n[\s\S]*?\n```/g;

function attachmentCharsIn(content: string): number {
  if (!ATTACHMENT_HEADER.test(content)) return 0;
  let chars = 0;
  for (const m of content.matchAll(ATTACHMENT_BLOCK)) {
    chars += m[0].length;
  }
  return chars;
}

export function computeContextUsage(
  messages: Message[],
  systemPrompt: string | null,
  params: GenerationParams,
): ContextUsageBreakdown {
  const systemPromptTokens = estimateTokens(systemPrompt);

  let messageChars = 0;
  let attachmentChars = 0;
  let nonSystemCount = 0;
  for (const m of messages) {
    // The chatHistory builder excludes role:"system" rows (sent via the
    // system_prompt field) AND messages flagged `compacted_at` (rolled
    // into the running auto-summary). Mirror both filters here so the
    // popup's "what reaches the model" estimate stays accurate after a
    // compaction.
    if (m.role === "system") continue;
    if (m.compacted_at != null) continue;
    nonSystemCount += 1;
    messageChars += m.content.length;
    if (m.thinking) messageChars += m.thinking.length;
    if (m.role === "user") {
      attachmentChars += attachmentCharsIn(m.content);
    }
  }

  const messagesTokens = Math.ceil(messageChars / 4);
  const attachmentsTokens = Math.ceil(attachmentChars / 4);
  const used = systemPromptTokens + messagesTokens;
  const total =
    typeof params.num_ctx === "number" && params.num_ctx > 0
      ? params.num_ctx
      : FALLBACK_CTX;
  const ratio = total > 0 ? Math.min(1, used / total) : 0;

  return {
    systemPromptTokens,
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

/** Format an integer token count compactly: 1234 → "1.2k", 12345 → "12k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}
