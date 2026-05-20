import { makeRequestId, startChatStream } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";
import type { ProviderId, SpaceMemory } from "@/types";

/**
 * Cap on how many memories we hand to the extractor model when asking it to
 * dedupe. Beyond this we'd burn the chat model's context for diminishing
 * returns; the local string-similarity check on insert catches anything the
 * model misses. Picked to fit comfortably even in tiny 2K-context Ollama
 * builds when the rest of the prompt is small.
 */
const MAX_MEMORIES_IN_PROMPT = 60;

/**
 * Cap on how much assistant + user text we feed the extractor. Large code
 * blocks etc. eat the model's context and the durable facts that warrant
 * memory rarely come from the tail of a long answer. Still generous enough
 * to handle a typical multi-paragraph reply.
 */
const TURN_CHAR_BUDGET = 8_000;

/** What the extractor model is supposed to return — a list of one-line
 *  facts we should persist. Anything else (commentary, JSON wrappers we
 *  don't expect) gets filtered or ignored downstream. */
interface ExtractionPayload {
  memories: string[];
}

/**
 * One end-to-end run of the memory extractor for a finished assistant turn.
 *
 * Flow:
 *   1. Build a tight extractor prompt that names every existing memory so
 *      the model can dedupe at the LLM level.
 *   2. Fire a non-displayed chat stream against the same provider/model/
 *      base_url the user is chatting with.
 *   3. Parse the model's JSON output. Tolerant of fenced code blocks and
 *      stray prose around the JSON object.
 *   4. Run a local string-similarity dedupe on each candidate against the
 *      existing memories (belt-and-suspenders for when the model ignores
 *      the dedupe instruction).
 *   5. Insert survivors via the space store, then push one toast per save.
 *
 * Errors are caught at the boundary — extraction is best-effort and must
 * never disrupt the user's chat flow.
 */
export async function extractMemories(args: {
  spaceId: string;
  sessionId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
}): Promise<void> {
  const {
    spaceId,
    sessionId,
    assistantMessageId,
    userText,
    assistantText,
    provider,
    model,
    baseUrl,
  } = args;

  if (!spaceId || !model) return;

  // Pull the latest cached memories — a stale cache would cause us to
  // re-add a row we just inserted earlier in the same session.
  const store = useSpaceStore.getState();
  let existing = store.spaceMemories[spaceId];
  if (!existing) {
    existing = await store.loadSpaceMemories(spaceId).catch(() => []);
  }

  const promptMemories = (existing ?? [])
    .slice(-MAX_MEMORIES_IN_PROMPT)
    .map((m) => m.content);

  const userTrimmed = clip(userText, TURN_CHAR_BUDGET);
  const assistantTrimmed = clip(assistantText, TURN_CHAR_BUDGET);

  const systemPrompt = buildExtractorSystemPrompt(promptMemories);
  const turnPrompt =
    `Conversation turn:\n` +
    `<user>\n${userTrimmed}\n</user>\n\n` +
    `<assistant>\n${assistantTrimmed}\n</assistant>\n\n` +
    `Return the JSON object now.`;

  let raw: string;
  try {
    raw = await runOneShotStream({
      provider,
      model,
      baseUrl,
      systemPrompt,
      userMessage: turnPrompt,
    });
  } catch (e) {
    logger.warn("memory extraction stream failed", e);
    return;
  }

  const parsed = parseExtractionJson(raw);
  if (!parsed || parsed.memories.length === 0) return;

  const existingNormalized = (existing ?? []).map((m) => normalize(m.content));
  const seenInRun = new Set<string>();

  for (const candidate of parsed.memories) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    // Reject pathological outputs — the prompt asks for one-liners; an
    // entire paragraph is almost always the model leaking context.
    if (trimmed.length > 280) continue;

    const norm = normalize(trimmed);
    if (!norm) continue;
    if (seenInRun.has(norm)) continue;
    if (isDuplicate(norm, existingNormalized)) continue;

    seenInRun.add(norm);
    try {
      const saved = await store.addMemory({
        space_id: spaceId,
        content: trimmed,
        source_session_id: sessionId,
        source_message_id: assistantMessageId,
      });
      existingNormalized.push(norm);
      announceSaved(saved);
    } catch (e) {
      logger.warn("failed to persist memory", e);
    }
  }
}

/**
 * Issue a single non-streaming chat call against the user-selected model
 * and resolve to the concatenated assistant text. We re-use
 * `startChatStream` so we don't have to duplicate the per-provider request
 * shaping in JS — we just buffer the tokens it emits, ignore the rest, and
 * resolve on `done`.
 *
 * Concurrent with the user's next chat: yes, but Ollama serialises
 * generation per-model and the extractor finishes quickly given the small
 * prompt + tight max_tokens.
 */
async function runOneShotStream(args: {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const { provider, model, baseUrl, systemPrompt, userMessage } = args;
  const streamId = makeRequestId();

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let unlistenFn: (() => void) | null = null;
    // `timedOut` covers the race where `startChatStream`'s setup takes
    // longer than the wall-clock budget: the timer fires first, but
    // `unlistenFn` is still null because the `.then` hasn't run. Without
    // this flag we'd silently leak the listener once the .then finally
    // installs it. We also use it to short-circuit the .then so we don't
    // hand a now-useless handle back into the world.
    let timedOut = false;

    const cleanup = () => {
      try {
        unlistenFn?.();
      } catch {
        /* already unlistened — harmless */
      }
      unlistenFn = null;
    };

    // Hard ceiling on extractor wall-clock. If a model goes off the rails
    // and never emits `done`, we'd otherwise leak a listener.
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      cleanup();
      reject(new Error("memory extraction timed out"));
    }, 60_000);

    startChatStream(
      {
        stream_id: streamId,
        provider,
        model,
        base_url: baseUrl,
        system_prompt: systemPrompt,
        messages: [
          { role: "user", content: userMessage, images: [] },
        ],
        params: {
          // Small budget — a JSON object with a handful of one-line facts
          // shouldn't need more.
          max_tokens: 512,
          // Low temperature — we want deterministic-ish dedupe behaviour.
          temperature: 0.2,
          // Suppress chain-of-thought when the model supports it; we only
          // care about the final JSON. Models that don't support `think`
          // ignore the field on the Rust side.
          think: false,
        },
      },
      (ev) => {
        if (ev.kind === "token") {
          buffer += ev.delta;
        } else if (ev.kind === "done") {
          window.clearTimeout(timeoutId);
          cleanup();
          resolve(buffer);
        } else if (ev.kind === "error") {
          window.clearTimeout(timeoutId);
          cleanup();
          reject(new Error(ev.message));
        }
      },
    )
      .then((handle) => {
        // The timer may have already fired and rejected the promise. If
        // it has, the handle's unlisten is the only thing keeping the
        // Rust-side event listener alive — call it immediately rather
        // than stashing it.
        if (timedOut) {
          try {
            handle.unlisten();
          } catch {
            /* ignore */
          }
          return;
        }
        unlistenFn = handle.unlisten;
      })
      .catch((e) => {
        window.clearTimeout(timeoutId);
        reject(e);
      });
  });
}

/**
 * The extractor's system prompt. Spelled out in plain English with a
 * worked example so even smaller local models stick to the JSON shape. We
 * instruct it to:
 *   - Skip one-shot/ephemeral facts ("the user is asking about X today")
 *   - Skip anything already in memory (we list the memories)
 *   - Return an empty list when nothing durable came up
 *   - Output ONLY a JSON object — never prose around it
 */
function buildExtractorSystemPrompt(existing: string[]): string {
  const memoryBlock =
    existing.length === 0
      ? "(none yet)"
      : existing.map((m, i) => `${i + 1}. ${m}`).join("\n");

  return [
    "You are a memory extractor for a chat application.",
    "Your only job: read one user/assistant turn and decide whether anything in it is a DURABLE fact about the user (preferences, identity, ongoing project, constraints, goals, recurring context) that should be remembered for future chats.",
    "",
    "Rules:",
    "- Return ONLY a single JSON object, no prose, no markdown fences. Shape: {\"memories\": [\"...\", \"...\"]}.",
    "- Each memory MUST be a single concise sentence (under 200 chars).",
    "- Do NOT include facts already covered by EXISTING MEMORIES below.",
    "- Do NOT include ephemeral content: the specific question being asked, generated code, transient errors, or summaries of the assistant's reply.",
    "- Do NOT speculate. Only record facts the user clearly stated or strongly implied about themselves or their work.",
    "- If nothing qualifies, return {\"memories\": []}.",
    "",
    "EXISTING MEMORIES:",
    memoryBlock,
    "",
    "Examples of GOOD memories:",
    "- \"Prefers TypeScript over JavaScript for new code.\"",
    "- \"Works on a Tauri desktop app called Loach.\"",
    "- \"Lives in Warsaw, Poland.\"",
    "",
    "Examples of BAD memories (do NOT extract these):",
    "- \"Is asking how to center a div.\"",
    "- \"The function returned an error.\"",
    "- \"Wants the answer in bullet points.\" (request-scoped, not durable)",
  ].join("\n");
}

/**
 * Best-effort JSON extractor. Models — especially smaller open ones — often
 * wrap JSON in ```json fences or pad it with a sentence or two of prose.
 * We grab the first `{...}` that parses to the shape we expect and drop
 * everything else.
 */
function parseExtractionJson(raw: string): ExtractionPayload | null {
  if (!raw) return null;
  // Strip common code-fence patterns first.
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  // Try a direct parse before scanning for embedded JSON — fast path for
  // models that follow the prompt.
  const direct = tryParse(cleaned);
  if (direct) return direct;

  // Scan for the first balanced `{...}` block. Naïve but fine: the
  // extractor system prompt forbids nested objects.
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1);
        const parsed = tryParse(slice);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function tryParse(s: string): ExtractionPayload | null {
  try {
    const obj = JSON.parse(s) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      Array.isArray((obj as { memories?: unknown }).memories)
    ) {
      const arr = (obj as { memories: unknown[] }).memories;
      const cleaned = arr.filter((x): x is string => typeof x === "string");
      return { memories: cleaned };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Lowercased, whitespace-collapsed, punctuation-stripped form used for
 *  similarity comparisons. Keeps "User likes TypeScript." and "user
 *  likes typescript" matching as duplicates. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Local dedupe layer that runs after the model has done its own pass.
 * Two checks: exact normalized match, and Jaccard token overlap above
 * 0.75 (catches phrasing-only differences like "Lives in Warsaw" vs.
 * "User lives in Warsaw, Poland.").
 */
function isDuplicate(candidate: string, existing: string[]): boolean {
  if (!candidate) return true;
  if (existing.includes(candidate)) return true;

  const candTokens = new Set(candidate.split(" ").filter(Boolean));
  if (candTokens.size === 0) return true;

  for (const ex of existing) {
    const exTokens = new Set(ex.split(" ").filter(Boolean));
    if (exTokens.size === 0) continue;
    let intersect = 0;
    for (const t of candTokens) if (exTokens.has(t)) intersect++;
    const union = candTokens.size + exTokens.size - intersect;
    const jaccard = union === 0 ? 0 : intersect / union;
    if (jaccard >= 0.75) return true;
    // Also flag containment — a shorter memory that's a strict subset of an
    // existing one is almost always redundant.
    if (intersect === candTokens.size && candTokens.size >= 3) return true;
  }
  return false;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** Push one "Saved to memory" toast per saved row. Mirrors ChatGPT's
 *  pattern — a soft pill in the corner with the saved text underneath
 *  so the user can verify what landed in long-term memory. */
function announceSaved(memory: SpaceMemory) {
  useToastStore.getState().push({
    kind: "memory",
    title: "Saved to memory",
    body: memory.content,
  });
}
