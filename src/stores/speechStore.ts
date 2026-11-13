import { create } from "zustand";
import { speechChunks } from "@/lib/speech";
import { useToastStore } from "@/stores/toastStore";

/** Read aloud uses the webview's Web Speech API — the OS's own voices, so it
 *  works offline and needs nothing from Rust. WebKitGTK builds compiled
 *  without speech support don't expose it at all. */
export const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window;

interface SpeechState {
  /** The message being read aloud, or null. One at a time: the
   *  synthesiser is global, so starting another reply stops this one. */
  speakingId: string | null;
  speak: (id: string, markdown: string) => void;
  /** Stop reading — with an id, only if that message is the one being read. */
  stop: (id?: string) => void;
}

// Bumped by every speak/stop, so the end/error events of utterances a newer
// run cancelled can't clear the newer run's state.
let run = 0;
// Held until spoken: Chromium can garbage-collect a queued utterance and then
// never fire its `end` event.
let queued: SpeechSynthesisUtterance[] = [];

export const useSpeechStore = create<SpeechState>((set, get) => ({
  speakingId: null,
  speak: (id, markdown) => {
    get().stop();
    const chunks = speechChunks(markdown);
    if (chunks.length === 0) {
      useToastStore.getState().push({
        kind: "info",
        title: "Nothing to read aloud",
        body: "This reply is only code or formulas.",
      });
      return;
    }
    const mine = run;
    // One utterance per paragraph: natural pauses, and no single utterance
    // runs into the engine's length limit on a long reply.
    queued = chunks.map((text, i) => {
      const u = new SpeechSynthesisUtterance(text);
      if (i === chunks.length - 1) {
        u.onend = () => {
          if (run === mine) get().stop();
        };
      }
      u.onerror = (e) => {
        if (run !== mine) return;
        get().stop();
        // `interrupted` / `canceled` come from a cancel(), not a failure.
        if (e.error !== "interrupted" && e.error !== "canceled") {
          useToastStore.getState().push({
            kind: "error",
            title: "Couldn't read aloud",
            body: "The system's speech engine reported an error.",
          });
        }
      };
      return u;
    });
    set({ speakingId: id });
    for (const u of queued) window.speechSynthesis.speak(u);
  },
  stop: (id) => {
    if (id !== undefined && get().speakingId !== id) return;
    run++;
    queued = [];
    if (speechAvailable) window.speechSynthesis.cancel();
    if (get().speakingId !== null) set({ speakingId: null });
  },
}));
