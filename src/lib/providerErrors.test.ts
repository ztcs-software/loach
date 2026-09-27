// `formatProviderError` classifies raw Rust error strings by ordered
// substring rules. The regression-prone parts: rule ORDER (first match wins),
// the digit-boundary guard on bare status codes (a port or byte count must
// not read as an HTTP status), and never losing information on the
// fallthrough path.

import { describe, it, expect } from "vitest";
import { formatProviderError } from "./providerErrors";
import type { ProviderId } from "@/types";

describe("formatProviderError", () => {
  it("formats the connection-refused family with provider label and URL", () => {
    const out = formatProviderError({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      raw: "tcp connect error: Connection refused (os error 10061)",
    });
    expect(out).toBe(
      "Ollama (http://localhost:11434) — could not reach the endpoint. Is it running and the URL correct?",
    );
  });

  it("omits the parenthesised URL when none is supplied", () => {
    const out = formatProviderError({ provider: "openai", raw: "401 Unauthorized" });
    expect(out).toBe("OpenAI — API key invalid or expired. Re-enter your key in Settings.");
  });

  it("matches bare status codes only as standalone tokens", () => {
    // ":5000" contains "500" but digit-adjacent — must NOT classify as a
    // server error; with no other rule matching, the raw text passes through.
    const raw = "listening on :5000 went wrong somehow";
    const out = formatProviderError({ provider: "ollama", raw });
    expect(out).toBe(`Ollama — ${raw}`);

    // The same code as a standalone token DOES classify.
    expect(
      formatProviderError({ provider: "ollama", raw: "HTTP status 500 from upstream" }),
    ).toContain("the upstream server returned an error");
  });

  it("applies the first matching rule when several could fire", () => {
    // Both "timed out" and "429" appear; the timeout rule is declared first.
    const out = formatProviderError({
      provider: "openai",
      raw: "request timed out after 429 ms",
    });
    expect(out).toContain("the request timed out");
    expect(out).not.toContain("rate limited");
  });

  it("keeps the withheld-key hint instead of reading as a wrong key", () => {
    const out = formatProviderError({
      provider: "openai",
      baseUrl: "http://192.168.1.20:8000/v1",
      raw:
        'OpenAI HTTP 401 Unauthorized: {"error":"missing key"} (API key withheld because the ' +
        "base URL is http:// to a non-loopback host — switch to https:// to authenticate)",
    });
    expect(out).toContain("API key withheld");
    expect(out).toContain("https://");
    expect(out).not.toContain("invalid or expired");
  });

  it("classifies out-of-memory errors ahead of the generic 5xx rule", () => {
    for (const body of [
      "llama runner process has terminated: cudaMalloc failed: out of memory",
      "model requires more system memory (5.6 GiB) than is available (3.2 GiB)",
      "llama runner process has terminated: error loading model: unable to allocate CUDA0 buffer",
    ]) {
      const out = formatProviderError({
        provider: "ollama",
        raw: `Ollama HTTP 500 Internal Server Error: {"error":"${body}"}`,
      });
      expect(out, body).toContain("ran out of memory");
      expect(out, body).not.toContain("upstream server");
    }
  });

  it("classifies context-window overflows", () => {
    const out = formatProviderError({
      provider: "openai",
      raw: "This model's maximum context length is 8192 tokens",
    });
    expect(out).toContain("too long for this model's context window");
  });

  it("keeps the raw message on fallthrough, stripping a leading 'Error: '", () => {
    const out = formatProviderError({ provider: "ollama", raw: "Error: kaboom xyz" });
    expect(out).toBe("Ollama — kaboom xyz");
  });

  it("falls back to the raw provider id for unknown providers", () => {
    const out = formatProviderError({
      provider: "lmstudio" as ProviderId,
      raw: "anything",
    });
    expect(out).toBe("lmstudio — anything");
  });
});
