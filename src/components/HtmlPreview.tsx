import { useEffect, useRef } from "react";
import { sandboxPreviewUrl } from "@/lib/tauri";

/**
 * Renders untrusted HTML — a model's code block, an `.html` attachment — as a
 * page inside the Code canvas.
 *
 * The page runs in a sandboxed iframe on the `loach-sandbox` protocol (see
 * `src-tauri/src/sandbox.rs` for what keeps it away from the app). The frame
 * loads a fixed host page that posts "ready"; we answer with the HTML and the
 * host replaces itself with it. Keying the iframe on `html` gives every new
 * source a fresh page, and a page that reloads itself asks again and gets
 * the same HTML back.
 */
export function HtmlPreview({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const src = sandboxPreviewUrl();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || e.source !== frame || e.data?.type !== "loach-preview:ready") {
        return;
      }
      // The frame's origin is opaque, so "*" is the only target that reaches
      // it; `frame-src` means only our own host page can be loaded there.
      frame.postMessage({ type: "loach-preview:render", html }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);

  if (!src) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        HTML preview is only available in the desktop app.
      </div>
    );
  }

  return (
    <iframe
      key={html}
      ref={frameRef}
      src={src}
      title="HTML preview"
      // No `allow-same-origin` (keeps the origin opaque), popups, modals,
      // downloads or top navigation. `allow-forms` is there only because
      // without it a form's `submit` event never fires, which breaks the
      // usual `preventDefault()` handler; the host CSP's `form-action 'none'`
      // still blocks the submission itself.
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      // White like a browser tab: a page that sets no background would
      // otherwise show the canvas through it.
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
