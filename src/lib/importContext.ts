/**
 * Parser for the "Import context" dialog. Three input shapes are accepted —
 * the same two we emit from `export_session` plus a plain-text fallback —
 * and they all collapse onto a single output type so the importer doesn't
 * have to branch on format itself.
 *
 * Detection order is important:
 *
 *   1. **JSON** — exported sessions look like `{ session, messages: [...] }`
 *      or, when a user pastes just the messages array, `[...]`. We try
 *      JSON first because the leading character is a strong signal and the
 *      `{}` braces are unambiguous (Markdown never starts with one).
 *   2. **Markdown** — `## You` / `## Assistant` / `## System` headers,
 *      same shape we emit. Detected by a single regex against any line.
 *   3. **Plain text** — anything else becomes one user message containing
 *      the verbatim text. Useful when the user wants to "feed" a transcript,
 *      summary, or article into the model without manually formatting it.
 */

export type ImportRole = "user" | "assistant" | "system";

export interface ImportedMessage {
  role: ImportRole;
  content: string;
}

export type ImportFormat = "json" | "markdown" | "plain" | "empty";

export interface ParsedImport {
  format: ImportFormat;
  messages: ImportedMessage[];
}

const EMPTY: ParsedImport = { format: "empty", messages: [] };

/**
 * Hard ceiling on JSON we'll attempt to parse. `JSON.parse` is synchronous
 * and runs on the UI thread; a multi-megabyte paste can freeze the app
 * for seconds. 4 MiB is comfortably above any realistic exported chat
 * transcript (a 10 000-message session JSON sits in low hundreds of KB)
 * while small enough that the parse stays sub-100 ms on a modern machine.
 */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function parseImportContext(text: string): ParsedImport {
  const trimmed = text.trim();
  if (!trimmed) return EMPTY;

  // ---- JSON branch ------------------------------------------------------

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Guard the synchronous `JSON.parse` against pathological inputs.
    // Pasting a 100 MB JSON file would otherwise freeze the renderer.
    // Fall through to the markdown/plain detectors on oversized input
    // so the user still gets *some* import behaviour — they'll most
    // likely end up in the plain-text branch, which keeps the app
    // responsive even if it's not exactly what they wanted.
    if (trimmed.length > MAX_JSON_BYTES) {
      console.warn(
        `parseImportContext: skipping JSON branch — input ${trimmed.length} bytes exceeds ${MAX_JSON_BYTES}-byte cap`,
      );
    } else {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const candidate = extractMessagesArray(parsed);
        const messages = candidate
          .map(normalizeMessage)
          .filter((m): m is ImportedMessage => !!m);
        if (messages.length > 0) {
          return { format: "json", messages };
        }
      } catch {
        // Malformed JSON — fall through; the user probably pasted
        // something that just happens to start with `{`.
      }
    }
  }

  // ---- Markdown branch --------------------------------------------------

  if (/^##\s+(You|Assistant|System)\b/m.test(trimmed)) {
    const messages = parseMarkdownSections(trimmed);
    if (messages.length > 0) {
      return { format: "markdown", messages };
    }
  }

  // ---- Plain text fallback ---------------------------------------------

  return {
    format: "plain",
    messages: [{ role: "user", content: trimmed }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessagesArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages;
    // Some users may paste OpenAI-style payloads — `{ messages: [...] }` is
    // already covered above; this branch handles a single bare message
    // shaped like `{ role, content }`.
    if (typeof obj.role === "string" && typeof obj.content === "string") {
      return [obj];
    }
  }
  return [];
}

function normalizeMessage(raw: unknown): ImportedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const rawRole =
    typeof m.role === "string" ? m.role.toLowerCase().trim() : "";
  const role: ImportRole | null =
    rawRole === "user" || rawRole === "assistant" || rawRole === "system"
      ? (rawRole as ImportRole)
      : rawRole === "you"
        ? "user"
        : rawRole === "ai" || rawRole === "bot" || rawRole === "model"
          ? "assistant"
          : null;
  if (!role) return null;

  let content = "";
  if (typeof m.content === "string") {
    content = m.content;
  } else if (Array.isArray(m.content)) {
    // OpenAI / Anthropic-style content blocks: stitch together any `text`
    // blocks and ignore the rest. Lossy for tool calls and images, but
    // preserves the readable conversation which is the point of import.
    content = m.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const t = (block as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  content = content.trim();
  if (!content) return null;
  return { role, content };
}

function parseMarkdownSections(md: string): ImportedMessage[] {
  // Match the section headers our exporter emits: lines that start with
  // `## You`, `## Assistant`, or `## System` and nothing else (we tolerate
  // trailing whitespace). Anything between this header and the next one
  // is the message body.
  const headerRe = /^##\s+(You|Assistant|System)\s*$/gm;
  const headers: { role: ImportRole; start: number; end: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(md)) !== null) {
    const role: ImportRole =
      m[1] === "You" ? "user" : m[1] === "Assistant" ? "assistant" : "system";
    headers.push({ role, start: m.index, end: m.index + m[0].length });
  }

  const out: ImportedMessage[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const next = headers[i + 1];
    const body = md.slice(cur.end, next?.start ?? md.length).trim();
    if (body) out.push({ role: cur.role, content: body });
  }
  return out;
}
