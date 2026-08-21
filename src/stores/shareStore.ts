import { create } from "zustand";

/** What the share dialog is currently showing. */
export interface ShareTarget {
  role: "user" | "assistant";
  /** Exactly the text to share — callers pass what's rendered on screen
   *  (the user bubble's content already has inlined attachments stripped). */
  content: string;
}

interface ShareState {
  /** Non-null opens the dialog. */
  target: ShareTarget | null;
  open: (target: ShareTarget) => void;
  close: () => void;
}

/** One dialog for every message, opened from the message kebabs — mirrors
 *  how the snippet editor is driven, so the (canvas-backed) dialog isn't
 *  mounted once per bubble in the transcript. */
export const useShareStore = create<ShareState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
