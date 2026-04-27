import type { GenerationParams } from "@/types";

/**
 * Maps Ollama PARAMETER lines (the raw text returned by `/api/show` in the
 * `parameters` field) onto our `GenerationParams` shape.
 *
 * Ollama uses `num_predict` for the generation cap, while we mirror OpenAI's
 * `max_tokens` internally — they're the same concept, so we translate. Any
 * key the user's Modelfile lists that isn't relevant to inference (notably
 * `stop`, `mirostat*`, `tfs_z`) is silently dropped.
 */
const KEY_MAP: Record<string, keyof GenerationParams> = {
  temperature: "temperature",
  top_p: "top_p",
  top_k: "top_k",
  min_p: "min_p",
  num_predict: "max_tokens",
  num_ctx: "num_ctx",
  repeat_penalty: "repeat_penalty",
  frequency_penalty: "frequency_penalty",
  presence_penalty: "presence_penalty",
  seed: "seed",
};

/**
 * Parse the multiline `parameters` block from `ollama_show_model` into a
 * sparse `GenerationParams` patch. Returns `{}` for empty / null inputs so
 * callers can spread it unconditionally.
 *
 * Format Ollama emits (one per line):
 *
 *     temperature 0.6
 *     top_p 0.95
 *     stop "<|im_end|>"
 *
 * Some keys (e.g. `stop`) appear multiple times — we ignore those entirely.
 * For the keys we do care about, the last occurrence wins.
 */
export function parseModelParameters(
  text: string | null | undefined,
): Partial<GenerationParams> {
  if (!text) return {};
  const out: Partial<GenerationParams> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const target = KEY_MAP[key];
    if (!target) continue;

    // Strip surrounding double-quotes (Ollama wraps strings); not relevant
    // for the numeric keys we accept, but cheap to keep generic.
    const value = rawValue.replace(/^"(.*)"$/, "$1").trim();

    if (target === "seed") {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) out.seed = n;
      continue;
    }
    const n = parseFloat(value);
    if (Number.isFinite(n)) {
      // The numeric fields all share `number` as their type, so the cast
      // here is the narrowest indirection that keeps TS happy without
      // listing every key by name.
      (out as Record<string, number>)[target] = n;
    }
  }
  return out;
}
