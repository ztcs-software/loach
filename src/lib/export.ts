import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportSession } from "./tauri";

export async function exportSessionToFile(
  sessionId: string,
  title: string,
  format: "json" | "md",
) {
  const defaultPath = `${sanitize(title)}.${format}`;
  const path = await save({
    defaultPath,
    filters: [
      format === "json"
        ? { name: "JSON", extensions: ["json"] }
        : { name: "Markdown", extensions: ["md"] },
    ],
  });
  if (!path) return;
  const content = await exportSession(sessionId, format);
  await writeTextFile(path, content);
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "chat";
}
