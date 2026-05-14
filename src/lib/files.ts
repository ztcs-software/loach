import type { Attachment } from "@/types";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const SPACE_BYTES_CAP = 200 * 1024 * 1024; // 200 MB total per space

/**
 * Per-attachment extracted-text ceiling.
 *
 * Reached only by very large documents (a 500-page contract or a research
 * paper with appendices). 200,000 chars ≈ 50,000 tokens — fits inside any
 * frontier model's window with room left for the conversation, and beats
 * the alternative of "the request silently 400s past the model's context
 * limit". When we hit the cap during extraction we set
 * {@link Attachment.truncated} so the UI can flag it and inline a marker
 * so the model knows the slice is partial.
 */
export const MAX_EXTRACTED_CHARS = 200_000;

/**
 * Combined inline-content ceiling for a single outgoing user message.
 *
 * Caps the sum of (typed-prompt + attachment-bodies + fetched-URL-bodies).
 * Once exceeded, subsequent inlined blobs are dropped with a "couldn't be
 * inlined" footer. Earlier-uploaded attachments win — they're more likely
 * to be the user's primary focus. The model is told via a footer either
 * way so it can ask the user to narrow the scope.
 */
export const MAX_INLINED_CHARS_PER_MESSAGE = 500_000;

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
    super(`${name} exceeds the 20 MB limit (${size} bytes)`);
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

interface ExtractionResult {
  text: string;
  truncated: boolean;
}

async function extractPdfText(buf: ArrayBuffer): Promise<ExtractionResult> {
  const pdfjs = await getPdfjs();
  // `data` is cloned internally; pass a fresh Uint8Array to avoid
  // "ArrayBuffer detached" when the same buffer is reused.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const totalPages = doc.numPages;
  const pages: string[] = [];
  let charsAccum = 0;
  let pagesExtracted = 0;
  // Stop extracting once the running char count crosses the cap. We still
  // pay the cost of decoding the page that pushes us over (so the loop
  // can't infinitely-loop on a degenerate page), but we don't keep going
  // past it.
  for (let i = 1; i <= totalPages; i++) {
    if (charsAccum >= MAX_EXTRACTED_CHARS) break;
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    // Each item either exposes a `str` (TextItem) or is a marker (TextMarkedContent).
    const pageText = textContent.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (pageText) {
      pages.push(`# Page ${i}\n${pageText}`);
      charsAccum += pageText.length + 16; // +overhead for the "# Page N\n" header
    }
    pagesExtracted = i;
  }
  await doc.cleanup();
  await doc.destroy();

  let text = pages.join("\n\n");
  let truncated = pagesExtracted < totalPages;
  // Hard final clip — the per-page accumulator can overshoot the cap on a
  // single very long page. Slicing by chars (not bytes) is safe because
  // `text` is a JS string (UTF-16 code units; surrogate pair handling is
  // a non-issue for the marker since we append after the slice).
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS);
    truncated = true;
  }
  if (truncated) {
    text += `\n\n[…document truncated: ${pagesExtracted} of ${totalPages} pages extracted (≈${text.length.toLocaleString()} chars). Ask the user for specific later sections if you need them.]`;
  }
  return { text, truncated };
}

async function extractDocxText(buf: ArrayBuffer): Promise<ExtractionResult> {
  const mammoth = await import("mammoth/mammoth.browser");
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  const raw = value.trim();
  if (raw.length <= MAX_EXTRACTED_CHARS) {
    return { text: raw, truncated: false };
  }
  // DOCX has no "page" abstraction we can rely on (mammoth doesn't expose
  // pagination), so we just clip the leading slice and stamp a marker.
  const text =
    raw.slice(0, MAX_EXTRACTED_CHARS) +
    `\n\n[…document truncated at ${MAX_EXTRACTED_CHARS.toLocaleString()} chars of ${raw.length.toLocaleString()} total. Ask the user for specific later sections if you need them.]`;
  return { text, truncated: true };
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
    const { text, truncated } = await extractPdfText(buf);
    return {
      kind: "text",
      name: file.name,
      mime: PDF_MIME,
      data:
        text ||
        "[PDF contained no extractable text — it may be a scanned image. Try attaching it as an image instead for a vision-capable model.]",
      truncated: truncated || undefined,
    };
  }

  // DOCX — extract raw text
  if (mime === DOCX_MIME || ext === "docx") {
    const buf = await file.arrayBuffer();
    const { text, truncated } = await extractDocxText(buf);
    return {
      kind: "text",
      name: file.name,
      mime: DOCX_MIME,
      data: text || "[DOCX contained no extractable text.]",
      truncated: truncated || undefined,
    };
  }

  // Text / code files — read as plain text so they can be inlined into the prompt
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(file.name.toLowerCase()) || mime.startsWith("text/")) {
    let text = await file.text();
    let truncated = false;
    if (text.length > MAX_EXTRACTED_CHARS) {
      text =
        text.slice(0, MAX_EXTRACTED_CHARS) +
        `\n\n[…file truncated at ${MAX_EXTRACTED_CHARS.toLocaleString()} chars. Ask the user for specific sections if you need more.]`;
      truncated = true;
    }
    return {
      kind: "text",
      name: file.name,
      mime: mime || "text/plain",
      data: text,
      truncated: truncated || undefined,
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
 *
 * Enforces {@link MAX_INLINED_CHARS_PER_MESSAGE} on the total returned
 * string. Attachments are processed in upload order — once the running
 * total would exceed the budget, the current attachment is body-clipped
 * (or skipped if it can't even fit its frame), and any remaining
 * attachments are listed by name in a single trailing footer so the model
 * still knows they exist.
 *
 * @param maxTotalChars Optional override of the per-message ceiling, useful
 *   if a caller wants to reserve budget for a later append (e.g. fetched
 *   web pages — see {@link inlineFetchedPages}).
 */
export function inlineTextAttachments(
  content: string,
  attachments: Attachment[],
  maxTotalChars: number = MAX_INLINED_CHARS_PER_MESSAGE,
): string {
  const texts = attachments.filter((a) => a.kind === "text");
  const binary = attachments.filter((a) => a.kind === "file");
  if (texts.length === 0 && binary.length === 0) return content;

  let out = content;
  const skippedNames: string[] = [];
  for (const a of texts) {
    const label =
      a.mime === "application/pdf"
        ? `Attached PDF: \`${a.name}\` (text extracted)`
        : a.mime.includes("wordprocessingml")
          ? `Attached Word document: \`${a.name}\` (text extracted)`
          : `Attached file: \`${a.name}\``;
    const header = `\n\n---\n${label}\n\`\`\`\n`;
    const footer = "\n```";
    const wrapCost = header.length + footer.length;
    const remaining = maxTotalChars - out.length - wrapCost;

    if (remaining <= 200) {
      // Not enough room for even a tiny preview — defer this and any
      // remaining attachments to the by-name footer below.
      skippedNames.push(a.name);
      continue;
    }

    let body = a.data;
    let clippedHere = false;
    if (body.length > remaining) {
      body = body.slice(0, remaining);
      clippedHere = true;
    }
    out += header + body;
    if (clippedHere) {
      out +=
        "\n\n[…this attachment was clipped here to fit the per-message size budget. Ask the user to send a focused excerpt if you need more.]";
    }
    out += footer;
  }

  if (skippedNames.length > 0) {
    const names = skippedNames.map((n) => `\`${n}\``).join(", ");
    out += `\n\n---\nThe user also attached ${skippedNames.length === 1 ? "this file" : `these ${skippedNames.length} files`} but ${skippedNames.length === 1 ? "its contents didn't" : "their contents didn't"} fit in this turn's size budget: ${names}. Ask the user to narrow the scope if you need ${skippedNames.length === 1 ? "it" : "them"}.`;
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
