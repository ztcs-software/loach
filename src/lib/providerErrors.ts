// Friendly formatting for provider error strings.
//
// Why this exists: when a chat stream fails, the user used to see the raw
// error message in their transcript, e.g. `_⚠ Connection refused (os error 61)_`.
// Useful in DevTools, useless to a non-developer trying to figure out what to
// do next. This module converts those into a sentence the user can act on:
//
//   _⚠ Ollama (http://localhost:11434) — could not reach the endpoint. Is it running?_
//   _⚠ OpenAI — API key invalid or expired. Re-enter your key in Settings._
//
// The mapping is heuristic on the raw error string because the providers
// don't surface structured error codes through our IPC layer — they ship a
// `format!("…")` from Rust. If we tighten the type later this module is the
// natural place for the upgrade. The fallthrough keeps the original message
// so we never lose information.

import type { ProviderId } from "@/types";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
};

interface Mapping {
  /** Substrings searched in the raw error message (lowercased). The order of
   *  the rules matters — first match wins, so put the most specific ones
   *  first. */
  match: string[];
  /** Function building the friendly tail of the message. Receives the
   *  original raw message in case the rendition wants to splice in detail. */
  build: (raw: string) => string;
}

const MAPPINGS: Mapping[] = [
  // Network connectivity. `os error 61` is BSD/macOS ECONNREFUSED; `os error
  // 10061` is Windows WSAECONNREFUSED; the reqwest stringification always
  // includes the human "Connection refused" tail too. The TLS/cert family is
  // a separate bucket because the user-actionable fix is different.
  {
    match: [
      "connection refused",
      "econnrefused",
      "tcp connect error",
      "failed to connect",
      "could not connect",
    ],
    build: () => "could not reach the endpoint. Is it running and the URL correct?",
  },
  {
    match: ["dns", "name resolution", "name or service not known", "no such host"],
    build: () => "could not resolve the host name. Check the URL for typos.",
  },
  {
    match: ["timed out", "timeout", "deadline"],
    build: () => "the request timed out. Try again or pick a smaller request.",
  },
  {
    match: ["tls", "ssl", "certificate", "invalid peer", "x509"],
    build: () => "TLS/certificate error. The endpoint's HTTPS configuration may be broken.",
  },
  // HTTP status codes. Order matters: we want `429` to match before
  // `400-4xx` if we ever add a generic bucket. Currently each row is exact.
  {
    match: ["401", "unauthorized"],
    build: () => "API key invalid or expired. Re-enter your key in Settings.",
  },
  {
    match: ["403", "forbidden"],
    build: () => "API key not authorized for this endpoint or model.",
  },
  {
    match: ["404", "not found"],
    build: () => "endpoint or model not found. Check the model name and URL.",
  },
  {
    match: ["429", "rate limit", "too many requests"],
    build: () => "rate limited. Wait a moment and try again.",
  },
  {
    match: ["500", "502", "503", "504", "internal server error", "bad gateway", "service unavailable"],
    build: () => "the upstream server returned an error. Try again later.",
  },
  {
    match: ["context length", "context window", "max_tokens", "maximum context"],
    build: () => "the conversation is too long for this model's context window. Start a new chat or pick a model with a bigger window.",
  },
];

// Match a single needle against the lowercased error string. Purely numeric
// needles (HTTP status codes) match only as standalone tokens, so a port
// (`:5000`), a model name (`gpt-4o-2024`), or a byte count can't be mistaken
// for a status code. Word needles keep plain substring matching. We avoid
// regex lookbehind for older-WebKit (macOS) compatibility.
function matchNeedle(hay: string, needle: string): boolean {
  if (/^\d+$/.test(needle)) {
    return new RegExp(`(^|\\D)${needle}(\\D|$)`).test(hay);
  }
  return hay.includes(needle);
}

/**
 * Build the `_⚠ … _` Markdown-italicised error line that ends up inside the
 * assistant message bubble. The line is always:
 *
 *   `_⚠ <Provider>[ (<url>)] — <friendly>_`
 *
 * with an optional bracketed URL when the call site knows it (we usually do
 * for Ollama; OpenAI uses the user-configured base URL too). When no rule
 * matches, the friendly tail is just the original `raw` message — we never
 * blank out information the provider gave us.
 */
export function formatProviderError(opts: {
  provider: ProviderId;
  baseUrl?: string;
  raw: string;
}): string {
  const { provider, baseUrl, raw } = opts;
  const label = PROVIDER_LABEL[provider] ?? provider;
  const hay = raw.toLowerCase();
  const matched = MAPPINGS.find((m) =>
    m.match.some((needle) => matchNeedle(hay, needle)),
  );
  const friendly = matched ? matched.build(raw) : raw;
  // Strip a leading "Error: " that the Rust side sometimes prepends —
  // looks odd next to our own "_⚠" prefix.
  const tidy = friendly.replace(/^error:\s*/i, "");
  // We only show the base URL when we have one; OpenAI's default endpoint
  // is well-known so the URL is mostly useful for self-hosted setups, but
  // it doesn't hurt to surface it consistently.
  const where = baseUrl ? ` (${baseUrl})` : "";
  return `${label}${where} — ${tidy}`;
}
