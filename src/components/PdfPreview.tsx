import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilePreview } from "./FilePreview";
import { getPdfjs, saveAttachment } from "@/lib/files";
import { useToastStore } from "@/stores/toastStore";
import type { Attachment } from "@/types";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

interface PdfPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachment: Attachment;
}

/**
 * Decode a base64 string into the raw byte view pdfjs expects. `atob` is
 * already part of the WebView runtime so this stays dependency-free; the
 * single loop over the binary string is cheap relative to pdfjs's own
 * parse step that runs immediately after.
 */
function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Full-screen PDF preview, mirroring the ImagePreview lightbox: dark
 * overlay, top-right close, primary Save button below the page list. Pages
 * are rendered lazily as they scroll into view so a 200-page PDF doesn't
 * burn CPU and memory rasterising everything up front.
 *
 * Falls back to FilePreview when the attachment has no raw bytes (older
 * messages, or a future case where extraction succeeded but bytes weren't
 * preserved). Same fallback fires if pdfjs throws — saves the user from
 * staring at an empty overlay if a PDF is malformed.
 */
export function PdfPreview({ open, onOpenChange, attachment }: PdfPreviewProps) {
  // No bytes → there's nothing to render. Defer to the placeholder dialog so
  // the user still gets a working Save (which falls back to writing the
  // extracted text).
  if (!attachment.bytes) {
    return <FilePreview open={open} onOpenChange={onOpenChange} attachment={attachment} />;
  }
  return <PdfPreviewBody open={open} onOpenChange={onOpenChange} attachment={attachment} />;
}

function PdfPreviewBody({ open, onOpenChange, attachment }: PdfPreviewProps) {
  const [saving, setSaving] = useState(false);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pushToast = useToastStore((s) => s.push);

  // Load the document whenever the dialog opens; tear it down on close so
  // pdfjs releases the page caches. Re-runs on `attachment` identity change
  // so opening a different PDF after closing the first works.
  useEffect(() => {
    if (!open || !attachment.bytes) return;
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const pdfjs = await getPdfjs();
        const task = pdfjs.getDocument({ data: base64ToUint8(attachment.bytes!) });
        loaded = await task.promise;
        if (cancelled) {
          await loaded.cleanup();
          await loaded.destroy();
          return;
        }
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      setDoc(null);
      setLoadError(null);
      if (loaded) {
        void loaded.cleanup();
        void loaded.destroy();
      }
    };
  }, [open, attachment]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveAttachment(attachment);
    } catch (e) {
      pushToast({
        kind: "error",
        title: "Save failed",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  // pdfjs failed to parse the document — fall back to the placeholder so the
  // user can still save it as a binary blob. We render that branch via the
  // sibling component so the dialog cleanly unmounts the half-loaded state.
  if (loadError) {
    return <FilePreview open={open} onOpenChange={onOpenChange} attachment={attachment} />;
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 bottom-0 top-9 z-[95] bg-black/75 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onClick={(e) => {
            if (e.target === e.currentTarget) onOpenChange(false);
          }}
          className="fixed inset-x-0 bottom-0 top-9 z-[95] flex flex-col items-center gap-4 p-6 pt-12 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{attachment.name}</DialogPrimitive.Title>
          <div
            // Pages live inside a card-shaped scroller so the overlay's
            // click-outside-to-close behaviour stays available when the user
            // clicks past the page edges (a wide PDF on a narrow window).
            // `max-w-4xl` (896px) gives A4 pages roughly their native CSS
            // width without overflowing typical chat-pane viewports.
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[calc(100vh-12rem)] w-full max-w-4xl flex-col items-center gap-3 overflow-auto rounded-lg p-2"
          >
            {!doc ? (
              <div className="flex items-center gap-2 py-12 text-white/70">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading PDF…</span>
              </div>
            ) : (
              Array.from({ length: doc.numPages }, (_, i) => (
                <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} />
              ))
            )}
          </div>
          <Button
            onClick={handleSave}
            disabled={saving}
            size="sm"
            className="bg-white/15 text-white hover:bg-white/25"
          >
            <Download className="h-4 w-4" />
            {saving ? "Saving…" : "Save"}
          </Button>
          <DialogPrimitive.Close
            aria-label="Close preview"
            className="absolute right-4 top-4 rounded-full bg-white/15 p-2 text-white/85 transition-colors hover:bg-white/25 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * One PDF page, lazy-rendered. We start as a placeholder sized to the page's
 * natural aspect ratio (cheap to compute — `getPage()` is fast, only the
 * raster step is expensive) and trigger the actual `page.render()` once the
 * placeholder enters the viewport. This keeps a 500-page legal PDF from
 * pinning the renderer for seconds on open.
 */
function PdfPage({ doc, pageNumber }: { doc: PDFDocumentProxy; pageNumber: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  // Compute the page's natural pixel dimensions immediately so the placeholder
  // takes the right amount of space — otherwise every page would be a zero-
  // height div and IntersectionObserver would fire for all of them at once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      // 1.5× scale is a good readability default — sharp on standard
      // monitors without making A4 pages overflow on common laptop widths.
      const viewport = page.getViewport({ scale: 1.5 });
      if (!cancelled) {
        setDims({ width: viewport.width, height: viewport.height });
      }
      page.cleanup();
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  // IntersectionObserver flips `visible` once the placeholder enters (or
  // gets near) the viewport. `rootMargin` extends the trigger zone so pages
  // start rendering slightly before they're scrolled into view — masks the
  // raster latency for fast scrollers.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Once visible, kick off the actual page render. We rasterise at 2× the
  // CSS width so the canvas stays sharp when CSS scales it down to fit the
  // container — the previous version set an explicit pixel `style.width` on
  // the canvas, which overflowed the dialog's max-width and clipped the
  // page horizontally. Letting CSS own the layout via `w-full` keeps every
  // page snapped to the scroller's width.
  useEffect(() => {
    if (!visible || rendered) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    (async () => {
      const page = await doc.getPage(pageNumber);
      // 2× device-pixel-ratio is a good sharpness/cost balance: high-DPI
      // displays get crisp text, while CPU/memory cost stays bounded
      // (one A4 page at 2×2 is ~3 MB of pixel data — fine even for a
      // 100-page PDF).
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: 2 * dpr });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) {
        page.cleanup();
        return;
      }
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        page.cleanup();
        return;
      }
      renderTask = page.render({ canvas, canvasContext: ctx, viewport });
      try {
        await renderTask.promise;
        if (!cancelled) setRendered(true);
      } catch {
        // `render()` rejects when its task is cancelled mid-flight — expected
        // during unmount, nothing to surface.
      } finally {
        page.cleanup();
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          /* ignore */
        }
      }
    };
  }, [visible, rendered, doc, pageNumber]);

  // Container fills the scroller's width (capped by its `max-w-4xl`); the
  // `aspectRatio` from the page's natural dimensions keeps the placeholder
  // at the right height before the canvas finishes rasterising.
  return (
    <div
      ref={containerRef}
      className="relative w-full shrink-0 overflow-hidden rounded-md bg-white shadow-lg"
      style={
        dims
          ? { aspectRatio: `${dims.width} / ${dims.height}` }
          : { aspectRatio: "8.5 / 11" }
      }
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
