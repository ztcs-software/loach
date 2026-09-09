/**
 * Pure, store-free helpers behind the memory extractor (`memory.ts`): the
 * extractor prompt, the tolerant JSON parser for the model's reply, the
 * local dedupe pass, and the prompt-injection cap. Kept apart from
 * `memory.ts` so they can be unit-tested without mocking the Tauri bridge
 * or the stores.
 */

/**
 * Cap on how many memories go into a prompt — both the block the chat
 * model sees on every turn and the EXISTING MEMORIES list the extractor
 * dedupes against. The same number in both places on purpose: the
 * extractor can only update or retire a memory it was shown, so showing the
 * chat model a wider window than the extractor would let stale facts ride
 * along that the extractor can never correct. Picked to fit comfortably
 * even in tiny 2K-context Ollama builds when the rest of the prompt is
 * small.
 */
export const MAX_MEMORIES_IN_PROMPT = 60;

/** Longest fact we accept from the extractor. The prompt asks for one-liners;
 *  an entire paragraph is almost always the model leaking context. */
export const MAX_MEMORY_CHARS = 280;

/** What the extractor model returns. `n` values are 1-based positions in
 *  the EXISTING MEMORIES list the prompt showed it. */
export interface ExtractionPayload {
  add: string[];
  update: { n: number; content: string }[];
  remove: number[];
}

/**
 * Pick the memories that go into a prompt when a scope holds more than the
 * cap: the newest `cap` rows, still in chronological order so the model
 * reads them the same way the Memory tab lists them. Under the cap the
 * input is returned as-is.
 */
export function selectMemoriesForPrompt<T extends { created_at: number }>(
  rows: T[],
  cap: number = MAX_MEMORIES_IN_PROMPT,
): T[] {
  if (rows.length <= cap) return rows;
  return [...rows].sort((a, b) => a.created_at - b.created_at).slice(-cap);
}

/**
 * The extractor's system prompt. Spelled out in plain English with worked
 * examples so even smaller local models stick to the JSON shape. We
 * instruct it to:
 *   - Skip one-shot/ephemeral facts ("the user is asking about X today")
 *   - Skip anything already in memory (we list the memories, numbered)
 *   - Correct or retire a listed memory the turn shows has changed, rather
 *     than adding a second, contradicting one
 *   - Return empty lists when nothing durable came up
 *   - Output ONLY a JSON object — never prose around it
 *
 * `alreadyKnown` is context the model must not repeat but also can't edit
 * here — the global memories, when extracting for a Space.
 */
export function buildExtractorSystemPrompt(
  existing: string[],
  alreadyKnown: string[] = [],
): string {
  const memoryBlock =
    existing.length === 0
      ? "(none yet)"
      : existing.map((m, i) => `${i + 1}. ${m}`).join("\n");

  const knownBlock =
    alreadyKnown.length === 0
      ? []
      : [
          "",
          "ALREADY KNOWN (global facts — never repeat these, and they cannot be edited here):",
          ...alreadyKnown.map((m) => `- ${m}`),
        ];

  return [
    "You are a memory extractor for a chat application.",
    "Your only job: read the conversation turn(s) and decide whether they contain DURABLE facts about the user (preferences, identity, ongoing project, constraints, goals, recurring context) that should be remembered for future chats — and whether any EXISTING MEMORY has changed.",
    "",
    "Rules:",
    "- Return ONLY a single JSON object, no prose, no markdown fences. Shape: {\"add\": [\"...\"], \"update\": [{\"n\": 2, \"content\": \"...\"}], \"remove\": [5]}.",
    "- \"add\": new durable facts. Each MUST be a single concise sentence (under 200 chars).",
    "- \"update\": when a turn shows an EXISTING MEMORY has changed (a preference reversed, a move to a new city, a project renamed), put the corrected sentence here with that memory's number. NEVER add a second memory that contradicts an existing one.",
    "- \"remove\": numbers of EXISTING MEMORIES the turn shows are no longer true and have no replacement.",
    "- Do NOT add facts already covered by EXISTING MEMORIES or ALREADY KNOWN facts.",
    "- Do NOT include ephemeral content: the specific question being asked, generated code, transient errors, or summaries of the assistant's reply.",
    "- Do NOT speculate. Only record facts the user clearly stated or strongly implied about themselves or their work.",
    "- If nothing qualifies, return {\"add\": [], \"update\": [], \"remove\": []}.",
    "",
    "EXISTING MEMORIES:",
    memoryBlock,
    ...knownBlock,
    "",
    "Examples of GOOD additions:",
    "- \"Prefers TypeScript over JavaScript for new code.\"",
    "- \"Works on a Tauri desktop app called Loach.\"",
    "- \"Lives in Warsaw, Poland.\"",
    "",
    "Example of an UPDATE: existing memory 3 is \"Lives in Warsaw, Poland.\" and the user says they moved to Berlin → {\"add\": [], \"update\": [{\"n\": 3, \"content\": \"Lives in Berlin, Germany.\"}], \"remove\": []}",
    "",
    "Examples of BAD additions (do NOT extract these):",
    "- \"Is asking how to center a div.\"",
    "- \"The function returned an error.\"",
    "- \"Wants the answer in bullet points.\" (request-scoped, not durable)",
  ].join("\n");
}

/**
 * Best-effort JSON extractor. Models — especially smaller open ones — often
 * wrap JSON in ```json fences or pad it with a sentence or two of prose.
 * We grab the first `{...}` that parses to the shape we expect and drop
 * everything else. The pre-update shape `{"memories": [...]}` is still
 * accepted (as plain additions) for models that echo an older prompt.
 */
export function parseExtractionJson(raw: string): ExtractionPayload | null {
  if (!raw) return null;
  // Strip common code-fence patterns first.
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  // Try a direct parse before scanning for embedded JSON — fast path for
  // models that follow the prompt.
  const direct = tryParse(cleaned);
  if (direct) return direct;

  // Scan for the first balanced `{...}` block that parses. Braces inside
  // string values are rare enough in one-line facts to ignore.
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
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const hasShape = ["add", "memories", "update", "remove"].some((k) =>
    Array.isArray(o[k]),
  );
  if (!hasShape) return null;

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const update = Array.isArray(o.update)
    ? o.update.flatMap((u) => {
        if (!u || typeof u !== "object") return [];
        const { n, content } = u as { n?: unknown; content?: unknown };
        if (!Number.isInteger(n) || typeof content !== "string") return [];
        return [{ n: n as number, content }];
      })
    : [];
  const remove = Array.isArray(o.remove)
    ? o.remove.filter((n): n is number => Number.isInteger(n))
    : [];

  return {
    add: [...strings(o.add), ...strings(o.memories)],
    update,
    remove,
  };
}

/** Lowercased, whitespace-collapsed, punctuation-stripped form used for
 *  similarity comparisons. Keeps "User likes TypeScript." and "user
 *  likes typescript" matching as duplicates. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Local dedupe layer that runs after the model has done its own pass. Both
 * inputs are `normalize`d. Two bag-of-words checks — exact match, and
 * Jaccard token overlap above 0.75 or strict containment (catches
 * phrasing-only differences like "Lives in Warsaw" vs. "User lives in
 * Warsaw, Poland.") — confirmed by a word-ORDER check: a bag of words
 * can't tell "Prefers TypeScript over JavaScript" from its reversal, so a
 * candidate only counts as a duplicate when at least half of its adjacent
 * word pairs also appear in the existing memory.
 */
export function isDuplicate(candidate: string, existing: string[]): boolean {
  if (!candidate) return true;
  if (existing.includes(candidate)) return true;

  const candTokens = tokenSet(candidate);
  if (candTokens.size === 0) return true;
  const candBigrams = bigramSet(candidate);

  for (const ex of existing) {
    const exTokens = tokenSet(ex);
    if (exTokens.size === 0) continue;
    let intersect = 0;
    for (const t of candTokens) if (exTokens.has(t)) intersect++;
    const union = candTokens.size + exTokens.size - intersect;
    const jaccard = union === 0 ? 0 : intersect / union;
    const bagMatch =
      jaccard >= 0.75 ||
      (intersect === candTokens.size && candTokens.size >= 3);
    if (!bagMatch) continue;

    // Sentences too short to have word pairs fall back to the bag result.
    const exBigrams = bigramSet(ex);
    if (candBigrams.size === 0 || exBigrams.size === 0) return true;
    let shared = 0;
    for (const b of candBigrams) if (exBigrams.has(b)) shared++;
    if (shared / Math.min(candBigrams.size, exBigrams.size) >= 0.5) return true;
  }
  return false;
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

function bigramSet(s: string): Set<string> {
  const words = s.split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}
