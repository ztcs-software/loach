import type { Attachment } from "@/types";

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "log", "json", "xml", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "env", "sh", "bash", "zsh", "fish",
  "bat", "cmd", "ps1", "py", "js", "ts", "jsx", "tsx", "html", "htm",
  "css", "scss", "sass", "less", "sql", "graphql", "gql",
  "rs", "go", "java", "kt", "c", "cpp", "h", "hpp", "cs", "swift",
  "rb", "php", "lua", "r", "m", "pl", "ex", "exs", "erl", "hs",
  "scala", "clj", "dart", "zig", "nim", "v", "vue", "svelte",
  "dockerfile", "makefile", "cmake", "gitignore", "editorconfig",
]);

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class FileTooLargeError extends Error {
  constructor(public readonly name: string, public readonly size: number) {
    super(`${name} exceeds the 15 MB limit (${size} bytes)`);
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_FILE_BYTES) {
    throw new FileTooLargeError(file.name, file.size);
  }
  const ext = extOf(file.name);
  const mime = file.type || "";

  // Images
  if (IMAGE_MIMES.has(mime) || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    const buf = await file.arrayBuffer();
    return {
      kind: "image",
      name: file.name,
      mime: mime || `image/${ext === "jpg" ? "jpeg" : ext}`,
      data: arrayBufferToBase64(buf),
    };
  }

  // Text / code files — read as plain text so they can be inlined into the prompt
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(file.name.toLowerCase()) || mime.startsWith("text/")) {
    const text = await file.text();
    return {
      kind: "text",
      name: file.name,
      mime: mime || "text/plain",
      data: text,
    };
  }

  // Everything else (PDF, Word, archives, etc.) — store as base64
  const buf = await file.arrayBuffer();
  return {
    kind: "file",
    name: file.name,
    mime: mime || "application/octet-stream",
    data: arrayBufferToBase64(buf),
  };
}

/**
 * Inline text attachments into a user message as fenced context blocks so
 * models receive file contents as prompt context.
 */
export function inlineTextAttachments(
  content: string,
  attachments: Attachment[],
): string {
  const texts = attachments.filter((a) => a.kind === "text");
  if (texts.length === 0) return content;
  const blocks = texts
    .map(
      (a) =>
        `\n\n---\nAttached file: \`${a.name}\`\n\`\`\`\n${a.data}\n\`\`\``,
    )
    .join("");
  return `${content}${blocks}`;
}

export function imagesFromAttachments(attachments: Attachment[]): string[] {
  return attachments.filter((a) => a.kind === "image").map((a) => a.data);
}
