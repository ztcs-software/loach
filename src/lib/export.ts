import { stripSummaryBlock } from "./contextUsage";
import type { Message, Session } from "@/types";

/**
 * Build a compacted Markdown export. Mirrors the Rust `export_session` "md"
 * layout (title, provider line, `## Role` sections) so Full and Compacted
 * exports read consistently side by side — but the older messages are
 * replaced by `summary` and only the `tail` messages render verbatim. The
 * user's own system prompt is preserved (minus any prior auto-summary block,
 * which `summary` supersedes).
 */
export function buildCompactedMarkdown(
  session: Session,
  summary: string,
  tail: Message[],
): string {
  let out = `# ${session.title}\n\n`;
  out += `_Provider: ${session.provider} · Model: ${session.model}_\n\n`;

  const userPrompt = stripSummaryBlock(session.system_prompt ?? null).trim();
  if (userPrompt) {
    out += `## System prompt\n\n${userPrompt}\n\n`;
  }

  out += `## Summary of earlier messages\n\n${summary}\n\n`;

  for (const m of tail) {
    const role =
      m.role === "user"
        ? "You"
        : m.role === "assistant"
          ? "Assistant"
          : "System";
    out += `## ${role}\n\n${m.content}\n\n`;
  }
  return out;
}
