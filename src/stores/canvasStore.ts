import { create } from "zustand";

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

  open: (args: {
    code: string;
    language: string | null;
    title?: string;
  }) => void;
  close: () => void;
}

/**
 * Holds the artifact currently shown in the right-side code canvas.
 *
 * Single-slot — opening a different code block replaces the contents. Once
 * artifacts get versioned (model-driven edits, scrubber UI), this becomes
 * the natural home for the artifact list / current revision; for now it's a
 * read-only viewer so a single-snapshot shape is enough.
 */
export const useCanvasStore = create<CanvasState>((set) => ({
  isOpen: false,
  code: "",
  language: null,
  title: null,
  open: ({ code, language, title }) =>
    set({ isOpen: true, code, language, title: title ?? null }),
  close: () => set({ isOpen: false }),
}));
