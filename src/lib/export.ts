import { stripSummaryBlock } from "./contextUsage";
import type { Session } from "@/types";

/**
 * Build a compacted Markdown export. Mirrors the Rust `export_session` "md"
 * layout (title, provider line, `## Role` sections) so Full and Compacted
 * exports read consistently side by side — but the messages are replaced by
 * `summary`. The user's own system prompt is preserved (minus any prior
 * auto-summary block, which `summary` supersedes).
 */
export function buildCompactedMarkdown(session: Session, summary: string): string {
  let out = `# ${session.title}\n\n`;
  out += `_Provider: ${session.provider} · Model: ${session.model}_\n\n`;

  const userPrompt = stripSummaryBlock(session.system_prompt ?? null).trim();
  if (userPrompt) {
    out += `## System prompt\n\n${userPrompt}\n\n`;
  }

  out += `## Summary of earlier messages\n\n${summary}\n\n`;
  return out;
}
