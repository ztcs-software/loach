import { create } from "zustand";
import type { CanvasBinding } from "./canvasStore";

/** One popped-out OS window showing code. When `binding` is set, the
 *  `CodeWindowBridge` streams the bound message's last code block into the
 *  window as it generates; static windows (attachments, completed blocks)
 *  carry a null binding and never receive updates. */
interface CodeWindowEntry {
  binding: CanvasBinding | null;
  /** Last code string emitted to the window — so the bridge only fires an
   *  IPC event when the content actually changed. */
  lastSent: string;
}

interface CodeWindowState {
  windows: Record<string, CodeWindowEntry>;
  register: (label: string, binding: CanvasBinding | null, initialCode: string) => void;
  unregister: (label: string) => void;
  markSent: (label: string, code: string) => void;
}

/**
 * Tracks the set of open pop-out code windows in the MAIN window. Lives apart
 * from `canvasStore` because pop-outs are multi-instance and outlive the
 * single in-app canvas slot — a user can pop out, then close the in-app
 * canvas, and the window must keep streaming.
 */
export const useCodeWindowStore = create<CodeWindowState>((set) => ({
  windows: {},
  register: (label, binding, initialCode) =>
    set((s) => ({
      windows: { ...s.windows, [label]: { binding, lastSent: initialCode } },
    })),
  unregister: (label) =>
    set((s) => {
      if (!(label in s.windows)) return s;
      const next = { ...s.windows };
      delete next[label];
      return { windows: next };
    }),
  markSent: (label, code) =>
    set((s) => {
      const entry = s.windows[label];
      if (!entry) return s;
      return { windows: { ...s.windows, [label]: { ...entry, lastSent: code } } };
    }),
}));
