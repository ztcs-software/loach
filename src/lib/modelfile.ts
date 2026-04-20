import type { ModelfileForm, ModelfileParams } from "@/types";

/**
 * Build a Modelfile string from the editor form so we can POST it to
 * `/api/create`. Roughly:
 *
 * ```
 * FROM llama3.1:8b
 *
 * SYSTEM """
 * You are a helpful assistant.
 * """
 *
 * TEMPLATE """<|user|>{{ .Prompt }}<|assistant|>"""
 *
 * PARAMETER temperature 0.7
 * PARAMETER top_p 0.95
 * PARAMETER stop "<|end|>"
 * PARAMETER stop "<|eot|>"
 * ```
 *
 * Only non-null, non-empty fields are emitted. Triple-quoted string
 * directives handle multi-line values without escaping; single-quoted
 * `PARAMETER stop` entries are escaped for embedded double quotes and
 * backslashes.
 */
export function buildModelfile(form: ModelfileForm): string {
  const lines: string[] = [];
  if (!form.from.trim()) {
    throw new Error('Base model ("FROM") is required.');
  }
  lines.push(`FROM ${form.from.trim()}`);

  if (form.system.trim()) {
    lines.push("", `SYSTEM """${form.system}"""`);
  }
  if (form.template.trim()) {
    lines.push("", `TEMPLATE """${form.template}"""`);
  }

  const paramLines = paramsToLines(form.params);
  if (paramLines.length > 0) {
    lines.push("", ...paramLines);
  }

  // Trailing newline is the convention in Ollama's docs.
  return lines.join("\n") + "\n";
}

/** Serialise a ModelfileParams into `PARAMETER <k> <v>` lines. Skips any
 *  field that is null / undefined / blank so the derived model inherits the
 *  base model's value for that knob. */
function paramsToLines(p: ModelfileParams): string[] {
  const out: string[] = [];
  const push = (k: string, v: number | null | undefined) => {
    if (v === null || v === undefined) return;
    if (!Number.isFinite(v)) return;
    out.push(`PARAMETER ${k} ${v}`);
  };

  push("temperature", p.temperature);
  push("top_p", p.top_p);
  push("top_k", p.top_k);
  push("min_p", p.min_p);
  push("num_ctx", p.num_ctx);
  push("num_predict", p.num_predict);
  push("num_batch", p.num_batch);
  push("num_gpu", p.num_gpu);
  push("num_thread", p.num_thread);
  push("repeat_penalty", p.repeat_penalty);
  push("repeat_last_n", p.repeat_last_n);
  push("frequency_penalty", p.frequency_penalty);
  push("presence_penalty", p.presence_penalty);
  push("tfs_z", p.tfs_z);
  push("typical_p", p.typical_p);
  push("mirostat", p.mirostat);
  push("mirostat_eta", p.mirostat_eta);
  push("mirostat_tau", p.mirostat_tau);
  push("seed", p.seed);

  if (p.stop && p.stop.length > 0) {
    for (const s of p.stop) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`PARAMETER stop "${escaped}"`);
    }
  }

  return out;
}

/** Parse the `parameters` block returned by `/api/show` into our editor
 *  shape. Ollama returns it as a single string like:
 *  ```
 *  temperature 0.6
 *  top_p 0.9
 *  stop "<|end|>"
 *  stop "<|eot|>"
 *  ```
 *  This is a best-effort extractor — unknown keys are ignored; known numeric
 *  keys are parsed; `stop` entries accumulate into an array. Malformed lines
 *  are silently skipped (we'd rather show a partially-filled form than blow
 *  up on a parameter we don't recognise).
 */
export function parseParamsBlock(block: string | null | undefined): ModelfileParams {
  const out: ModelfileParams = { stop: [] };
  if (!block) return out;

  const numericKeys: (keyof ModelfileParams)[] = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "num_ctx",
    "num_predict",
    "num_batch",
    "num_gpu",
    "num_thread",
    "repeat_penalty",
    "repeat_last_n",
    "frequency_penalty",
    "presence_penalty",
    "tfs_z",
    "typical_p",
    "mirostat",
    "mirostat_eta",
    "mirostat_tau",
    "seed",
  ];
  const known = new Set(numericKeys as string[]);

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // First whitespace splits key and value.
    const spaceIdx = line.search(/\s/);
    if (spaceIdx < 0) continue;
    const key = line.slice(0, spaceIdx).trim();
    let value = line.slice(spaceIdx + 1).trim();
    if (!key) continue;

    if (key === "stop") {
      // Strip surrounding quotes if present, unescape \" and \\.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      (out.stop ??= []).push(value);
      continue;
    }

    if (known.has(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) {
        (out as Record<string, unknown>)[key] = n;
      }
    }
  }

  return out;
}
