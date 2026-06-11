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

// Module-scoped map from toast id to its auto-dismiss timer id. Lets
// `dismiss()` cancel the pending sweep — otherwise the timer fires later
// against a now-empty toast list, leaking a closure per dismissed toast.
const dismissTimers = new Map<string, number>();

/** Most toasts visible at once. A burst of failures (e.g. the global
 *  rejection net catching a sweep of rejected mutations) evicts oldest-first
 *  instead of shingling the whole viewport in 4-second chips. */
const MAX_TOASTS = 5;

function startDismissTimer(
  id: string,
  set: (fn: (s: ToastState) => Partial<ToastState>) => void,
) {
  // Auto-dismiss after 4s — long enough for a glance, short enough to
  // not pile up if the extractor saves a stack of memories at once.
  const timerId = window.setTimeout(() => {
    dismissTimers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, 4000);
  dismissTimers.set(id, timerId);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    // Coalesce exact duplicates: re-pushing an identical toast restarts its
    // timer instead of stacking a copy, so a source failing repeatedly (a
    // retry loop, N identical rejections in one burst) shows one chip.
    const dup = get().toasts.find(
      (t) =>
        t.kind === toast.kind &&
        t.title === toast.title &&
        t.body === toast.body,
    );
    if (dup) {
      const timer = dismissTimers.get(dup.id);
      if (timer !== undefined) window.clearTimeout(timer);
      startDismissTimer(dup.id, set);
      return dup.id;
    }

    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Evict oldest beyond the cap, cancelling their pending sweeps so the
    // timers don't fire against the already-removed entries.
    const overflow = get().toasts.length + 1 - MAX_TOASTS;
    const evicted = new Set(
      overflow > 0 ? get().toasts.slice(0, overflow).map((t) => t.id) : [],
    );
    for (const evictedId of evicted) {
      const timer = dismissTimers.get(evictedId);
      if (timer !== undefined) window.clearTimeout(timer);
      dismissTimers.delete(evictedId);
    }
    set((s) => ({
      toasts: [...s.toasts.filter((t) => !evicted.has(t.id)), { id, ...toast }],
    }));
    startDismissTimer(id, set);
    return id;
  },
  dismiss: (id) => {
    const timer = dismissTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => {
    // Pull all pending timers so a `clear()` doesn't leave them firing
    // against a freshly-pushed toast that happens to reuse an id (very
    // unlikely with the time-plus-random format, but cheap to be safe).
    for (const timer of dismissTimers.values()) window.clearTimeout(timer);
    dismissTimers.clear();
    set({ toasts: [] });
  },
}));
