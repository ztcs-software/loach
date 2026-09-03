import { useEffect, useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildShareUrl, type ShareNetwork } from "@/lib/share";
import { renderShareImage, type ShareImage } from "@/lib/shareImage";
import { openExternal, saveBinaryToFile } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useShareStore } from "@/stores/shareStore";
import { useToastStore } from "@/stores/toastStore";

/* Brand marks. lucide dropped its social icons, and four one-off glyphs
 * don't justify a dependency — the paths live here next to their buttons. */
const BRAND_PATHS: Record<ShareNetwork, string> = {
  facebook:
    "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  reddit:
    "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-6.994 4.87-3.864 0-6.994-2.176-6.994-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12.9c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.688-.561-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z",
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
};

const NETWORKS: { id: ShareNetwork; label: string; hover: string }[] = [
  { id: "facebook", label: "Facebook", hover: "hover:bg-[#1877F2]" },
  { id: "x", label: "X", hover: "hover:bg-[#000000] dark:hover:bg-[#ffffff] dark:hover:text-black" },
  { id: "reddit", label: "Reddit", hover: "hover:bg-[#FF4500]" },
  { id: "linkedin", label: "LinkedIn", hover: "hover:bg-[#0A66C2]" },
];

/**
 * "Share" popup for a single message, opened from either kebab menu.
 *
 * Two modes: the raw text, or the same text drawn into a chat-bubble PNG.
 * Text mode offers Copy plus the four network buttons; the share intents are
 * text/link only, so image mode drops them for Copy + Save.
 */
export function ShareDialog() {
  const target = useShareStore((s) => s.target);
  const close = useShareStore((s) => s.close);
  const [mode, setMode] = useState<"text" | "image">("text");
  const [image, setImage] = useState<ShareImage | null>(null);
  const [imageError, setImageError] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fresh dialog, fresh state — the previous message's PNG must not flash in
  // while the new one renders.
  //
  // Adjusted during render rather than in an effect: as an effect this ran
  // AFTER paint, so reopening on a different message committed one frame
  // still showing the old target's mode and image. React re-runs the render
  // immediately with the corrected state and discards the abandoned output.
  const [renderedTarget, setRenderedTarget] = useState(target);
  if (renderedTarget !== target) {
    setRenderedTarget(target);
    setMode("text");
    setImage(null);
    setImageError(false);
    setCopied(false);
  }

  // Render on demand (and once per message) rather than on open, so sharing
  // as text never pays for the canvas work.
  useEffect(() => {
    if (!target || mode !== "image" || image) return;
    let cancelled = false;
    setImageError(false);
    void renderShareImage({
      role: target.role,
      text: target.content,
      dark: document.documentElement.classList.contains("dark"),
    })
      .then((img) => {
        if (!cancelled) setImage(img);
      })
      .catch((e) => {
        logger.error("share image render failed", e);
        if (!cancelled) setImageError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [target, mode, image]);

  if (!target) return null;

  const flashCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const copyText = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(target.content);
      return true;
    } catch {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't copy",
        body: "Clipboard isn't available in this window.",
      });
      return false;
    }
  };

  // Image clipboard writes need `ClipboardItem`, which older WebKitGTK (the
  // Linux webview) doesn't ship — point those users at Save instead.
  const copyImage = async (): Promise<boolean> => {
    if (!image) return false;
    try {
      if (typeof ClipboardItem === "undefined") throw new Error("no ClipboardItem");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": image.blob }),
      ]);
      return true;
    } catch (e) {
      logger.error("share image copy failed", e);
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't copy the image",
        body: "This window can't put images on the clipboard — use Save instead.",
      });
      return false;
    }
  };

  const saveImage = async () => {
    if (!image) return;
    try {
      const base64 = image.dataUrl.slice(image.dataUrl.indexOf(",") + 1);
      await saveBinaryToFile({
        base64_data: base64,
        default_path: "loach-message.png",
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
    } catch (e) {
      logger.error("share image save failed", e);
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't save the image",
        body: "The file couldn't be written.",
      });
    }
  };

  const handleCopy = async () => {
    const ok = mode === "text" ? await copyText() : await copyImage();
    if (ok) flashCopied();
  };

  const handleShare = async (network: ShareNetwork) => {
    try {
      await openExternal(buildShareUrl(network, target.content));
    } catch (e) {
      logger.error("share link open failed", e);
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't open the browser",
        body: "Loach wasn't able to hand the link to your browser.",
      });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Share {target.role === "user" ? "message" : "response"}</DialogTitle>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as "text" | "image")}>
          <TabsList>
            <TabsTrigger value="text">As text</TabsTrigger>
            <TabsTrigger value="image">As image</TabsTrigger>
          </TabsList>

          <TabsContent value="text">
            <div className="max-h-64 overflow-auto rounded-2xl border border-foreground/10 bg-foreground/[0.04] px-4 py-3">
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/85">
                {target.content}
              </p>
            </div>
          </TabsContent>

          <TabsContent value="image">
            <div className="flex max-h-64 items-center justify-center overflow-auto rounded-2xl border border-foreground/10 bg-foreground/[0.04] p-3">
              {image ? (
                <img
                  src={image.dataUrl}
                  alt="Preview of the message rendered as an image"
                  className="w-full rounded-xl"
                />
              ) : imageError ? (
                <span className="py-8 text-sm text-foreground/55">
                  Couldn't render the image.
                </span>
              ) : (
                <Loader2 className="my-8 h-5 w-5 animate-spin text-foreground/45" />
              )}
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex items-center justify-between gap-4">
          {/* Networks only take text or a link — an image can't ride along in a
              share URL — so image mode swaps them for Save. */}
          <div className="flex items-center gap-2">
            {mode === "text" &&
              NETWORKS.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  title={`Share on ${n.label}`}
                  aria-label={`Share on ${n.label}`}
                  onClick={() => void handleShare(n.id)}
                  className={cn(
                    "inline-flex h-10 w-10 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.06] text-foreground/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    n.hover,
                  )}
                >
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden>
                    <path d={BRAND_PATHS[n.id]} />
                  </svg>
                </button>
              ))}
          </div>
          <div className="flex items-center gap-2">
            {mode === "image" && (
              <Button
                variant="secondary"
                onClick={() => void saveImage()}
                disabled={!image}
              >
                <Download />
                Save
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => void handleCopy()}
              disabled={mode === "image" && !image}
            >
              {copied ? (
                <>
                  <Check className="text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy />
                  Copy
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
