import { create } from "zustand";

/** localStorage key for the persisted canvas width. */
const WIDTH_KEY = "loach:canvas-width";

/** Hard limits for the draggable canvas width. The min keeps the header
 *  controls from colliding; the max is computed per-resize against the
 *  viewport so the chat never gets squeezed to nothing. */
export const CANVAS_MIN_WIDTH = 320;

/** Lower bound of chat width we refuse to cross when sizing the canvas, so
 *  there's always a usable transcript next to it. */
const CHAT_MIN_WIDTH = 420;

/** Clamp a desired canvas width against the viewport so the chat stays
 *  usable. Exported so the drag handler and the initial read share one rule. */
export function clampCanvasWidth(width: number): number {
  const viewport =
    typeof window !== "undefined" ? window.innerWidth : 1280;
  const max = Math.max(CANVAS_MIN_WIDTH, viewport - CHAT_MIN_WIDTH);
  return Math.min(max, Math.max(CANVAS_MIN_WIDTH, Math.round(width)));
}

/** Initial width: the user's persisted choice, else a sensible default that
 *  mirrors the old `clamp(360px, 42vw, 720px)` behaviour. */
function initialWidth(): number {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(WIDTH_KEY);
    if (saved) {
      const n = Number(saved);
      if (Number.isFinite(n)) return clampCanvasWidth(n);
    }
    return clampCanvasWidth(window.innerWidth * 0.42);
  }
  return 560;
}

/** Identifies the live source a canvas is bound to: a specific message whose
 *  LAST fenced code block we mirror as it streams. Null for static snapshots
 *  (attachments, or a completed code block opened after the fact). */
export interface CanvasBinding {
  sessionId: string;
  messageId: string;
}

interface CanvasState {
  isOpen: boolean;
  /** Raw source pushed in by `CodeBlock` when the user hits "Open in canvas". */
  code: string;
  /** Highlight.js language id, lower-case (e.g. `python`, `tsx`). Used both
   *  to drive syntax highlighting in the canvas and to pick a default file
   *  extension on Export. */
  language: string | null;
  /** Optional human title shown in the canvas header. The canvas falls back
   *  to a derived label (e.g. "Python") when null. */
  title: string | null;
  /** Optional filename hint — used as the Export dialog's default file
   *  name when the canvas was opened from an attachment chip (so the saved
   *  file inherits the original name like `notes.md` instead of a generic
   *  `snippet.md`). Null when the canvas was opened from a code block in
   *  a model reply, where there's no source filename to preserve. */
  name: string | null;
  /** When set, the canvas mirrors the last fenced code block of this message
   *  as it streams. `code`/`language` still hold the snapshot captured at
   *  open time so the canvas renders before the first live tick and after the
   *  source message goes away. */
  binding: CanvasBinding | null;
  /** Current width of the canvas in px. Persisted across sessions. */
  width: number;

  /** Open with a static snapshot (attachments, completed blocks). */
  open: (args: {
    code: string;
    language: string | null;
    title?: string;
    name?: string;
  }) => void;
  /** Open bound to a streaming message's last code block. The snapshot seeds
   *  the initial render; the canvas re-derives from the live message after. */
  openLive: (args: {
    sessionId: string;
    messageId: string;
    code: string;
    language: string | null;
    title?: string;
  }) => void;
  close: () => void;
  setWidth: (width: number) => void;
}

/**
 * Holds the artifact currently shown in the right-side code canvas.
 *
 * Single-slot — opening a different code block replaces the contents. The
 * `binding` lets a single slot also track a still-streaming block (feature:
 * "auto-update code as it generates"); attachment-opened canvases keep
 * `binding` null and stay a static snapshot.
 */
export const useCanvasStore = create<CanvasState>((set) => ({
  isOpen: false,
  code: "",
  language: null,
  title: null,
  name: null,
  binding: null,
  width: initialWidth(),
  open: ({ code, language, title, name }) =>
    set({
      isOpen: true,
      code,
      language,
      title: title ?? null,
      name: name ?? null,
      binding: null,
    }),
  openLive: ({ sessionId, messageId, code, language, title }) =>
    set({
      isOpen: true,
      code,
      language,
      title: title ?? null,
      name: null,
      binding: { sessionId, messageId },
    }),
  close: () => set({ isOpen: false, binding: null }),
  setWidth: (width) => {
    const clamped = clampCanvasWidth(width);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WIDTH_KEY, String(clamped));
    }
    set({ width: clamped });
  },
}));
