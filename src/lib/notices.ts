import type { ToolCallRecord } from "@/types";

/** A reply's notice — something the backend told the user beside it (MCP
 *  servers that couldn't be reached) — is kept as a record in its tool-call
 *  list and drawn as a chip. As reply text, it was rendered as Markdown,
 *  replayed to the model as its own words, copied, exported and read by the
 *  memory extractor. */
export const NOTICE_TOOL = "loach_notice";

export function noticeRecord(text: string): ToolCallRecord {
  return {
    id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    server_id: "__builtin__",
    server_name: "Loach",
    tool: NOTICE_TOOL,
    arguments: {},
    result: text,
    is_error: true,
  };
}
