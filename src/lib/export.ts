import { exportSession, saveTextToFile } from "./tauri";

/**
 * Export a chat session to a file the user picks.
 *
 * The save dialog and the file write both run in Rust through a single
 * backend command — the renderer never sees the chosen path, so a
 * compromised UI cannot bypass the picker and write to a path it forged
 * itself.
 */
export async function exportSessionToFile(
  sessionId: string,
  title: string,
  format: "json" | "md",
) {
  const defaultPath = `${sanitize(title)}.${format}`;
  const filters = [
    format === "json"
      ? { name: "JSON", extensions: ["json"] }
      : { name: "Markdown", extensions: ["md"] },
  ];
  const content = await exportSession(sessionId, format);
  await saveTextToFile({ content, default_path: defaultPath, filters });
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "chat";
}
