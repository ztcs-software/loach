//! The Providers tab's 'Test connection' result card, plus the error
//! classifier behind its hint line.

import { CheckCircle2, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProviderId } from "@/types";

export type ConnTestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; modelCount: number }
  | { kind: "error"; error: string };



/** Bucket a raw connection-test error string into a short actionable hint.
 *  Pattern-matches against the messages the Rust admin path actually
 *  produces (SSRF guard text, reqwest's HTTP/IO display, our own URL-parse
 *  error). Returns an empty hint when nothing matches — the raw message is
 *  still shown verbatim above the hint, so unrecognised errors degrade
 *  gracefully instead of swallowing context. HTTP statuses read per
 *  provider: Ollama is asked for /api/tags and is sent no API key. */
export function classifyConnError(msg: string, provider: ProviderId): { hint: string } {
  const m = msg.toLowerCase();
  if (m.includes("refusing to connect")) {
    return {
      hint: "Loach blocks this address range — link-local hosts cloud-metadata services that shouldn't see LLM traffic. Use a public host or a private LAN address instead.",
    };
  }
  if (
    m.includes("could not parse base url") ||
    m.includes("invalid url") ||
    m.includes("relative url without a base")
  ) {
    return {
      hint: "The base URL didn't parse. Make sure it starts with http:// or https:// and has no typos.",
    };
  }
  if (
    m.includes("401") ||
    m.includes("unauthorized") ||
    m.includes("403") ||
    m.includes("forbidden")
  ) {
    return {
      hint:
        provider === "ollama"
          ? "The server rejected the request as unauthorized. Loach sends Ollama no credentials — if a proxy in front of it asks for a login, point Loach at Ollama directly."
          : "The server rejected the request as unauthorized. Check that the API key is set and valid for this endpoint.",
    };
  }
  if (m.includes("404") || m.includes("not found")) {
    return {
      hint:
        provider === "ollama"
          ? "Ollama's /api/tags endpoint wasn't found. Use the server's address without a path — e.g. http://localhost:11434, not …/v1 or …/api."
          : "The /models endpoint wasn't found. Double-check the base URL — OpenAI itself ends in /v1, but LiteLLM and Ollama's OpenAI-compat proxy don't.",
    };
  }
  if (
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("connection refused") ||
    m.includes("dns error") ||
    m.includes("error trying to connect") ||
    m.includes("network unreachable") ||
    m.includes("error sending request")
  ) {
    return {
      hint: "Couldn't reach the server. Is it running? Is the host/port correct? If it's a remote provider, check your internet connection.",
    };
  }
  return { hint: "" };
}

/** Inline success / failure card for the Providers "Test connection"
 *  buttons. Mirrors `McpPanel`'s TestResultCard styling so users see the
 *  same visual language no matter which connection they're checking. */
export function ConnTestResult({
  result,
  provider,
  providerLabel,
  className,
}: {
  result:
    | { kind: "ok"; modelCount: number }
    | { kind: "error"; error: string };
  provider: ProviderId;
  providerLabel: string;
  className?: string;
}) {
  if (result.kind === "error") {
    const { hint } = classifyConnError(result.error || "", provider);
    return (
      <div
        className={cn(
          "rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive",
          className,
        )}
      >
        <div className="flex items-center gap-1.5 font-medium">
          <CircleAlert className="h-4 w-4" />
          Connection failed
        </div>
        <p className="mt-1 text-[12px] text-destructive/90 break-words">
          {result.error || "Unknown error"}
        </p>
        {hint && (
          <p className="mt-1.5 text-[12px] text-destructive/75 break-words">
            {hint}
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        Connected
      </div>
      <p className="mt-1 text-[12px] text-foreground/75">
        {providerLabel} reachable · {result.modelCount}{" "}
        {result.modelCount === 1 ? "model" : "models"} available.
      </p>
    </div>
  );
}
