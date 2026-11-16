// The hint under a failed "Test connection": the same HTTP status means
// different things for Ollama (asked for /api/tags, sent no key) and an
// OpenAI-compatible endpoint (asked for /models with the stored key).

import { describe, expect, it } from "vitest";
import { classifyConnError } from "./ConnTest";

describe("classifyConnError", () => {
  it("points an OpenAI-compatible 404 at the /v1 suffix, but not Ollama's", () => {
    const msg = "HTTP status client error (404 Not Found) for url (http://localhost:11434/v1/api/tags)";
    expect(classifyConnError(msg, "openai").hint).toMatch(/\/models/);
    const ollama = classifyConnError(msg, "ollama").hint;
    expect(ollama).toMatch(/\/api\/tags/);
    expect(ollama).not.toMatch(/\/models|OpenAI/);
  });

  it("only suggests the API key for an OpenAI-compatible endpoint", () => {
    const msg = "HTTP status client error (401 Unauthorized)";
    expect(classifyConnError(msg, "openai").hint).toMatch(/API key/);
    expect(classifyConnError(msg, "ollama").hint).not.toMatch(/API key/);
    expect(classifyConnError(msg, "ollama").hint).toMatch(/unauthorized/);
  });

  it("gives both providers the same hint for errors that aren't about the endpoint", () => {
    for (const msg of ["error sending request: connection refused", "could not parse base URL"]) {
      expect(classifyConnError(msg, "ollama").hint).toBe(classifyConnError(msg, "openai").hint);
      expect(classifyConnError(msg, "ollama").hint).not.toBe("");
    }
    expect(classifyConnError("something else entirely", "ollama").hint).toBe("");
  });

  // F6-03: the key isn't sent over plain http to another machine, so the
  // server's 401 isn't about the key.
  it("explains a withheld key instead of blaming it", () => {
    const msg =
      "HTTP status client error (401 Unauthorized) for url (http://192.168.1.20:8000/v1/models) (API key withheld because the base URL is http:// to a non-loopback host — switch to https:// to authenticate)";
    const { hint } = classifyConnError(msg, "openai");
    expect(hint).toMatch(/https:\/\//);
    expect(hint).not.toMatch(/set and valid/);
  });

  // F6-02: what reqwest says about a URL with a space in it or no scheme.
  it("reads reqwest's URL errors as a URL problem", () => {
    for (const msg of ["builder error", "error sending request: URL scheme is not allowed"]) {
      expect(classifyConnError(msg, "ollama").hint).toMatch(/base URL didn't parse/);
    }
  });
});
