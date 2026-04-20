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

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

/** Lazy-loaded to keep the initial bundle small. */
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Vite picks this up via ?url and emits a static asset.
      const workerUrl = (
        await import("pdfjs-dist/build/pdf.worker.mjs?url")
      ).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await getPdfjs();
  // `data` is cloned internally; pass a fresh Uint8Array to avoid
  // "ArrayBuffer detached" when the same buffer is reused.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    // Each item either exposes a `str` (TextItem) or is a marker (TextMarkedContent).
    const pageText = textContent.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (pageText) pages.push(`# Page ${i}\n${pageText}`);
  }
  await doc.cleanup();
  await doc.destroy();
  return pages.join("\n\n");
}

async function extractDocxText(buf: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser");
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return value.trim();
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

  // PDF — extract text so the model can read it
  if (mime === PDF_MIME || ext === "pdf") {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf);
    return {
      kind: "text",
      name: file.name,
      mime: PDF_MIME,
      data:
        text ||
        "[PDF contained no extractable text — it may be a scanned image. Try attaching it as an image instead for a vision-capable model.]",
    };
  }

  // DOCX — extract raw text
  if (mime === DOCX_MIME || ext === "docx") {
    const buf = await file.arrayBuffer();
    const text = await extractDocxText(buf);
    return {
      kind: "text",
      name: file.name,
      mime: DOCX_MIME,
      data: text || "[DOCX contained no extractable text.]",
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

  // Everything else (legacy .doc, binary blobs, archives, etc.) — store as
  // base64 so the file is preserved and visible in the transcript, but flag
  // it so we can mention it to the model as "attached but unreadable".
  const buf = await file.arrayBuffer();
  return {
    kind: "file",
    name: file.name,
    mime: mime || "application/octet-stream",
    data: arrayBufferToBase64(buf),
  };
}

/**
 * Inline attachment contents into a user message so models receive file
 * contents as prompt context. Text-kind attachments are inlined verbatim;
 * unsupported binary attachments are mentioned by name.
 */
export function inlineTextAttachments(
  content: string,
  attachments: Attachment[],
): string {
  const texts = attachments.filter((a) => a.kind === "text");
  const binary = attachments.filter((a) => a.kind === "file");
  if (texts.length === 0 && binary.length === 0) return content;

  let out = content;
  for (const a of texts) {
    const label = a.mime === "application/pdf"
      ? `Attached PDF: \`${a.name}\` (text extracted)`
      : a.mime.includes("wordprocessingml")
        ? `Attached Word document: \`${a.name}\` (text extracted)`
        : `Attached file: \`${a.name}\``;
    out += `\n\n---\n${label}\n\`\`\`\n${a.data}\n\`\`\``;
  }
  if (binary.length > 0) {
    const names = binary.map((a) => `\`${a.name}\``).join(", ");
    out += `\n\n---\nThe user also attached ${binary.length === 1 ? "this file" : "these files"} whose contents this chat can't decode: ${names}. Ask the user to share it in a readable format if you need to use it.`;
  }
  return out;
}

export function imagesFromAttachments(attachments: Attachment[]): string[] {
  return attachments.filter((a) => a.kind === "image").map((a) => a.data);
}

/**
 * Inverse of `inlineTextAttachments` for display purposes. The full inlined
 * content stays in the DB (so chat history sent to the model is complete),
 * but we don't want to render huge PDFs / docs inline in the user bubble
 * when the file chip already communicates the attachment. Strips everything
 * from the first attachment header onwards.
 */
export function stripInlinedAttachments(content: string): string {
  // Also matches the "Fetched URL" / "Failed to fetch" headers produced by
  // `inlineFetchedPages` — same idea, same treatment: hide the bulky context
  // from the user's own bubble while keeping it in the stored content so the
  // model sees it on replay.
  const marker =
    /\n\n---\n(?:Attached |The user also attached |Fetched URL: |Failed to fetch )/;
  const m = marker.exec(content);
  return m ? content.slice(0, m.index).trimEnd() : content;
}
