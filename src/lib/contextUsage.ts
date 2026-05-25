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
    // The chatHistory builder excludes role:"system" rows because they're
    // sent via the system_prompt field. Mirror that here so the estimate
    // matches what actually reaches the model.
    if (m.role === "system") continue;
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

/** Format an integer token count compactly: 1234 → "1.2k", 12345 → "12k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}
