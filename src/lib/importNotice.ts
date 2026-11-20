// What an import changed on its way in, said to the user after the reload
// that follows it: MCP servers brought back switched off or renamed, and an
// OpenAI-compatible URL kept over the backup's. Without this it reached only
// the backend's log, and a success line said "Imported 3 MCP servers" while
// all three came back off.

import { useToastStore } from "@/stores/toastStore";
import type { ImportStats } from "@/types";

/** sessionStorage: it survives the reload, and nothing else. */
const KEY = "loach:import-notice";

/** The notice for `stats`, or null when the import changed nothing. */
export function importNoticeText(stats: ImportStats): string | null {
  const lines: string[] = [];
  const off = stats.mcp_disabled;
  if (off.length > 0) {
    lines.push(
      `${off.length === 1 ? "1 MCP server was" : `${off.length} MCP servers were`} imported switched off (${off.join(", ")}). Turn ${off.length === 1 ? "it" : "them"} on in Settings → MCP.`,
    );
  }
  if (stats.mcp_renamed.length > 0) {
    lines.push(`Renamed to fit the naming rule: ${stats.mcp_renamed.join(", ")}.`);
  }
  if (stats.openai_base_url_kept) {
    lines.push("Your OpenAI-compatible server address was kept: an API key is stored for it.");
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

/** Leave `stats`' notice for the page that loads after the reload. */
export function stashImportNotice(stats: ImportStats): void {
  const text = importNoticeText(stats);
  if (!text) return;
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    /* storage unavailable: nothing to carry */
  }
}

/** Show the notice a pre-reload import left, once. */
export function showImportNotice(): void {
  let text: string | null = null;
  try {
    text = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (!text) return;
  useToastStore.getState().push({
    kind: "info",
    title: "Imported, with changes",
    body: text,
    durationMs: 60_000,
  });
}
