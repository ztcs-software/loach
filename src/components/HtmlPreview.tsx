import { useEffect, useRef } from "react";
import { noteActivity } from "@/lib/autoLock";
import { sandboxPreviewUrl } from "@/lib/tauri";
import { useSecurityStore } from "@/stores/securityStore";

/** One of the host page's reports (`preview.html`): exactly `{ type }`. */
function isFrameMessage(data: unknown, type: string): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    Object.keys(data).length === 1 &&
    (data as { type?: unknown }).type === type
  );
}

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
      if (!frame || e.source !== frame) return;
      // Typing or playing in the frame never reaches the app's own listeners,
      // so the host page reports it, and the panic key pressed in there.
      // Nothing else the frame sends is honoured.
      if (isFrameMessage(e.data, "loach-preview:lock")) {
        useSecurityStore.getState().lock();
        return;
      }
      if (isFrameMessage(e.data, "loach-preview:activity")) {
        // The page can post this too, and could hold the idle lock off for
        // someone who walked away. So it counts only right after a real
        // click or keypress in the frame, whose user activation reaches this
        // window as well — or, where that isn't exposed, while the frame
        // has focus.
        const ua = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
        if (ua ? ua.isActive : document.activeElement === frameRef.current) noteActivity();
        return;
      }
      if (e.data?.type !== "loach-preview:ready") return;
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
