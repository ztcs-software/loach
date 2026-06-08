import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveBinaryToFile } from "@/lib/tauri";
import { safeImageMime } from "@/lib/files";
import { useToastStore } from "@/stores/toastStore";

interface ImagePreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** base64 (no `data:` prefix) — matches `Attachment.data`. */
  data: string;
  mime: string;
  /** Original filename, used as the default save name. */
  name: string;
}

function extForMime(mime: string, fallback: string): string {
  if (mime === "image/jpeg") return "jpg";
  const m = /^image\/([a-z0-9.+-]+)$/i.exec(mime);
  return m ? m[1].toLowerCase() : fallback;
}

export function ImagePreview({ open, onOpenChange, data, mime, name }: ImagePreviewProps) {
  const [saving, setSaving] = useState(false);
  const pushToast = useToastStore((s) => s.push);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const ext = extForMime(mime, "png");
      const defaultName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${ext}`;
      await saveBinaryToFile({
        base64_data: data,
        default_path: defaultName,
        filters: [{ name: "Image", extensions: [ext] }],
      });
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

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 bottom-0 top-9 z-[95] bg-black/75 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onClick={(e) => {
            // Content fills the whole dim area, so Radix's built-in "click
            // outside" never fires. Treat any click that lands directly on
            // this wrapper (not on the image or buttons inside it) as a
            // close, matching what users expect from a lightbox overlay.
            if (e.target === e.currentTarget) onOpenChange(false);
          }}
          // z-[95] sits the lightbox above the PrivateChat overlay
          // (z-[80]) and its dropdowns (z-[90]) so previewing an
          // attachment from inside a private chat works the same as from
          // a normal chat. Still below Toasts (z-[100]) so error toasts
          // surface visibly even with a preview open.
          className="fixed inset-x-0 bottom-0 top-9 z-[95] flex flex-col items-center justify-center gap-4 p-6 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{name}</DialogPrimitive.Title>
          <img
            src={`data:${safeImageMime(mime)};base64,${data}`}
            alt={name}
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-3rem)] rounded-lg object-contain shadow-2xl"
          />
          {/* The dim backdrop stays dark in both themes (standard lightbox
              treatment) so the buttons need theme-independent light colours
              — `foreground` would flip to near-black in light mode and
              disappear against the dark overlay. */}
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
