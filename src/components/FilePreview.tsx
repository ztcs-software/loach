import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, File, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveAttachment } from "@/lib/files";
import { useToastStore } from "@/stores/toastStore";
import type { Attachment } from "@/types";

interface FilePreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachment: Attachment;
}

/**
 * Fallback preview shown when we can't render the attachment's contents in
 * the app — DOCX files, binary blobs, scanned-only PDFs whose original bytes
 * we no longer have. Mirrors `ImagePreview`'s lightbox layout (overlay,
 * centered card, top-right close, primary action button below) so the chip
 * dispatch feels consistent regardless of which preview surfaces.
 */
export function FilePreview({ open, onOpenChange, attachment }: FilePreviewProps) {
  const [saving, setSaving] = useState(false);
  const pushToast = useToastStore((s) => s.push);

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

  const Icon = attachment.kind === "text" ? FileText : File;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 bottom-0 top-9 z-[95] bg-black/75 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onClick={(e) => {
            // Match ImagePreview — clicking outside the centered card closes
            // the dialog, but clicks on the card itself stay live so the
            // user can interact with the Save button without it dismissing.
            if (e.target === e.currentTarget) onOpenChange(false);
          }}
          className="fixed inset-x-0 bottom-0 top-9 z-[95] flex flex-col items-center justify-center gap-4 p-6 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{attachment.name}</DialogPrimitive.Title>
          <div
            // Inner card — fixed width, themed glass surface. Click events on
            // the card don't bubble to the wrapper's "click-outside-to-close"
            // handler, so the user can hit Save without the dialog dismissing
            // before the OS picker opens.
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-white/15 bg-zinc-900/85 px-8 py-10 text-center shadow-2xl backdrop-blur-xl"
          >
            <div className="grid h-20 w-20 place-items-center rounded-2xl bg-white/10">
              <Icon className="h-10 w-10 text-white/80" strokeWidth={1.5} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-base font-medium text-white">
                {attachment.name}
              </div>
              <div className="mt-1 text-sm text-white/55">
                Preview not available
              </div>
            </div>
          </div>
          {/* Save sits outside the card so its placement matches ImagePreview
              (centered, below the preview surface) — keeps the dispatcher
              feeling cohesive across kinds. */}
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
