import { useEffect } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { isTauri, dropCodeWindowPayload } from "@/lib/tauri";
import { useChatStore } from "@/stores/chatStore";
import { useCodeWindowStore } from "@/stores/codeWindowStore";
import { lastCodeBlock } from "@/lib/codeBlocks";
import { preprocessTex } from "./Markdown";

/**
 * Invisible controller mounted once in the MAIN window. Streams the live code
 * of bound pop-out windows (`Open in window` on a still-streaming block) into
 * those windows via `emitTo`, and prunes the registry when a window closes.
 *
 * Lives apart from `CodeCanvas` because a pop-out outlives the in-app canvas:
 * the user can pop out and then close the canvas, and the window must keep
 * receiving updates until the stream ends.
 */
export function CodeWindowBridge() {
  useEffect(() => {
    if (!isTauri) return;
    let raf: number | null = null;

    const tick = () => {
      raf = null;
      const store = useCodeWindowStore.getState();
      const labels = Object.keys(store.windows);
      if (labels.length === 0) return;
      const messages = useChatStore.getState().messages;
      for (const label of labels) {
        const entry = store.windows[label];
        if (!entry.binding) continue; // static pop-out — nothing to stream
        const { sessionId, messageId } = entry.binding;
        const msg = messages[sessionId]?.find((m) => m.id === messageId);
        if (!msg) continue;
        const block = lastCodeBlock(preprocessTex(msg.content));
        const code = block?.code ?? "";
        if (code !== entry.lastSent) {
          store.markSent(label, code);
          void emitTo(label, "code-window:update", {
            code,
            language: block?.language ?? null,
          }).catch(() => {
            /* window may have closed mid-emit — the closed listener prunes */
          });
        }
      }
    };

    const schedule = () => {
      if (raf == null) raf = requestAnimationFrame(tick);
    };

    // Re-evaluate on any chat change (new tokens) or registry change (a new
    // pop-out). rAF coalesces the per-token bursts into one emit per frame.
    const unsubChat = useChatStore.subscribe(schedule);
    const unsubWindows = useCodeWindowStore.subscribe(schedule);

    let unlistenClosed: (() => void) | null = null;
    void listen<{ label: string }>("code-window:closed", (e) => {
      useCodeWindowStore.getState().unregister(e.payload.label);
      // Free the Rust-side snapshot now that the window is gone.
      void dropCodeWindowPayload(e.payload.label);
    }).then((un) => {
      unlistenClosed = un;
    });

    return () => {
      unsubChat();
      unsubWindows();
      if (raf != null) cancelAnimationFrame(raf);
      if (unlistenClosed) unlistenClosed();
    };
  }, []);

  return null;
}
