import type { Attachment } from "@/types";

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "log", "json"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class FileTooLargeError extends Error {
  constructor(public readonly name: string, public readonly size: number) {
    super(`${name} exceeds the 15 MB limit (${size} bytes)`);
  }
}

export class UnsupportedFileError extends Error {
  constructor(public readonly name: string) {
    super(`${name} is not a supported file type`);
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

  if (IMAGE_MIMES.has(mime) || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    const buf = await file.arrayBuffer();
    return {
      kind: "image",
      name: file.name,
      mime: mime || `image/${ext === "jpg" ? "jpeg" : ext}`,
      data: arrayBufferToBase64(buf),
    };
  }

  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) {
    const text = await file.text();
    return {
      kind: "text",
      name: file.name,
      mime: mime || "text/plain",
      data: text,
    };
  }

  throw new UnsupportedFileError(file.name);
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
