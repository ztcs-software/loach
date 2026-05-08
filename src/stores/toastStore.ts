import { create } from "zustand";

/** A floating notification chip — the "Saved to memory" pill for the
 *  extractor is the only producer for now, but the store is generic so
 *  future ambient notifications (errors, "Copied", …) can re-use it
 *  without a second mount point. */
export interface Toast {
  id: string;
  /** Visual treatment. `memory` is the indigo-tinted pill with the brain
   *  icon shown when the extractor saves a fact; `info` / `error` are
   *  generic neutral / red surfaces for future producers. */
  kind: "memory" | "info" | "error";
  title: string;
  body?: string;
  /** Optional click handler — currently unused but reserved so a
   *  "Saved to memory" toast could deep-link to the Memory tab later. */
  onClick?: () => void;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ toasts: [...s.toasts, { id, ...toast }] }));
    // Auto-dismiss after 4s — long enough for a glance, short enough to
    // not pile up if the extractor saves a stack of memories at once.
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
