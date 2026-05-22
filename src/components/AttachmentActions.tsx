import { useState } from "react";
import { ImagePreview } from "./ImagePreview";
import { PdfPreview } from "./PdfPreview";
import { FilePreview } from "./FilePreview";
import { useCanvasStore } from "@/stores/canvasStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/types";

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type PreviewKind = "image" | "pdf" | "canvas" | "file";

/**
 * Decide what happens when the user clicks a chip.
 *
 *  - `image`  → ImagePreview lightbox.
 *  - `pdf`    → PdfPreview lightbox (we have the original bytes).
 *  - `canvas` → Code Canvas side panel (text / code / extracted PDF or DOCX
 *               text whose original bytes were lost on older messages).
 *  - `file`   → FilePreview placeholder (DOCX, binary blobs, scanned PDFs).
 *
 * The split keeps the dispatch logic in one spot so FileChip / Message /
 * future call sites all behave the same way when the user interacts with a
 * chip.
 */
function previewKindFor(a: Attachment): PreviewKind {
  if (a.kind === "image") return "image";
  if (a.kind === "file") return "file";
  // text-kind from here on
  if (a.mime === PDF_MIME) return a.bytes ? "pdf" : "file";
  if (a.mime === DOCX_MIME) return "file";
  return "canvas";
}

/**
 * Extension-based language hint for Code Canvas. Highlight.js accepts both
 * canonical ids and the common aliases (`py` ↔ `python`, `ts` ↔ `typescript`)
 * so passing the bare extension is usually enough — and when it isn't,
 * CodeCanvas falls back to `highlightAuto` so the file still highlights.
 */
function languageFromName(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i < 0) return null;
  const ext = name.slice(i + 1).toLowerCase();
  return ext || null;
}

interface AttachmentActionsProps {
  attachment: Attachment;
  /** The chip / thumbnail to wrap. Whatever is rendered here gets the
   *  click-to-preview behaviour. */
  children: React.ReactNode;
  /** Tailwind classes applied to the wrapping element. The wrapper is a
   *  block-inline span so it lays out the same as the chip it contains. */
  className?: string;
}

/**
 * Wraps a chip / thumbnail so it gets left-click "open preview" behaviour.
 * Owns the preview dialog state and routes to the right surface based on
 * the dispatch table (see `previewKindFor`).
 */
export function AttachmentActions({
  attachment,
  children,
  className,
}: AttachmentActionsProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const openCanvas = useCanvasStore((s) => s.open);
  // Code Canvas renders in the chat's right slot — when the PrivateChat
  // overlay is up (z-80, full-screen), the canvas would open behind it and
  // be invisible. Falling back to FilePreview gives the user a working
  // Preview dispatch inside PrivateChat without the canvas regression.
  const privateChatOpen = usePrivateChatStore((s) => s.open);

  const rawKind = previewKindFor(attachment);
  const kind: PreviewKind =
    rawKind === "canvas" && privateChatOpen ? "file" : rawKind;

  const openPreview = () => {
    if (kind === "canvas") {
      openCanvas({
        code: attachment.data,
        language: languageFromName(attachment.name),
        title: attachment.name,
        name: attachment.name,
      });
      return;
    }
    setPreviewOpen(true);
  };

  return (
    <>
      <span
        role="button"
        // `tabIndex={0}` puts the chip in tab order — image thumbnails used
        // to be `<button>`s and we don't want to regress keyboard reach
        // when wrapping them with this dispatcher.
        tabIndex={0}
        aria-label={`Open ${attachment.name}`}
        onClick={openPreview}
        onKeyDown={(e) => {
          // Match button activation semantics — Enter and Space both trigger
          // a click on `<button>`, so the role="button" span should behave
          // the same. Space would otherwise scroll the page (default
          // behaviour on focused non-button spans).
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPreview();
          }
        }}
        className={cn(
          "inline-flex cursor-pointer items-center outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/40",
          className,
        )}
      >
        {children}
      </span>

      {/* Preview dialog. Mounted only while open so cleanup effects in
          PdfPreview (page caches, doc.destroy) actually fire on close. */}
      {previewOpen && kind === "image" && (
        <ImagePreview
          open
          onOpenChange={setPreviewOpen}
          data={attachment.data}
          mime={attachment.mime}
          name={attachment.name}
        />
      )}
      {previewOpen && kind === "pdf" && (
        <PdfPreview
          open
          onOpenChange={setPreviewOpen}
          attachment={attachment}
        />
      )}
      {previewOpen && kind === "file" && (
        <FilePreview
          open
          onOpenChange={setPreviewOpen}
          attachment={attachment}
        />
      )}
    </>
  );
}
