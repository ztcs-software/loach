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
  /** Optional action button rendered inside the chip ("Undo"). Clicking
   *  runs the callback and dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Per-toast override for the auto-dismiss window. Defaults to the
   *  kind-based TTL below — reach for this only when the content needs a
   *  longer read/decide window (e.g. an Undo offer). */
  durationMs?: number;
}

/** Why a toast is being held open. Tracked separately because the two
 *  holders are independent: the pointer can leave a chip whose Undo button
 *  still has keyboard focus, and that must not re-arm the timer. */
export type HoldReason = "pointer" | "focus";

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
  /** Suspend a toast's auto-dismiss for one reason (pointer hover / keyboard
   *  focus). Pairs with `resume`; while held, duplicate pushes also won't
   *  re-arm the timer out from under the reader. Adding the same reason twice
   *  is a no-op, so an unbalanced pause can't strand a chip on screen. */
  pause: (id: string, reason: HoldReason) => void;
  /** Release one hold. The timer re-arms only once no reason remains.
   *  Restarts the full window rather than tracking remaining time — the user
   *  was reading, so a fresh read window is the friendlier behaviour and far
   *  less code. */
  resume: (id: string, reason: HoldReason) => void;
  clear: () => void;
}

// Module-scoped map from toast id to its auto-dismiss timer id. Lets
// `dismiss()` cancel the pending sweep — otherwise the timer fires later
// against a now-empty toast list, leaking a closure per dismissed toast.
const dismissTimers = new Map<string, number>();

// Toasts currently held open, and by which holders. `startDismissTimer`
// refuses to arm while a toast has any hold, so a duplicate `push` mid-hover
// can't sweep the chip away under the cursor.
const heldToasts = new Map<string, Set<HoldReason>>();

/** Most toasts visible at once. A burst of failures (e.g. the global
 *  rejection net catching a sweep of rejected mutations) evicts oldest-first
 *  instead of shingling the whole viewport in 4-second chips. */
const MAX_TOASTS = 5;

/** Auto-dismiss windows by kind. Info-grade chips ("Copied", "Saved to
 *  memory") only need a glance; errors carry a message the user has to
 *  actually read ("Couldn't reach Ollama — connection refused on …"), so
 *  they stay up long enough to finish the sentence. */
const TTL_BY_KIND: Record<Toast["kind"], number> = {
  memory: 4000,
  info: 4000,
  error: 10_000,
};

function ttlFor(toast: Pick<Toast, "kind" | "durationMs">): number {
  return toast.durationMs ?? TTL_BY_KIND[toast.kind];
}

function startDismissTimer(
  id: string,
  ms: number,
  set: (fn: (s: ToastState) => Partial<ToastState>) => void,
) {
  if (heldToasts.has(id)) return;
  const timerId = window.setTimeout(() => {
    dismissTimers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, ms);
  dismissTimers.set(id, timerId);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    // Coalesce exact duplicates: re-pushing an identical toast restarts its
    // timer instead of stacking a copy, so a source failing repeatedly (a
    // retry loop, N identical rejections in one burst) shows one chip.
    //
    // Toasts carrying an action are exempt. The identity keys say nothing
    // about what the action closes over — archive two chats before either is
    // auto-titled and both chips read "Moved to archive / New chat" — so
    // folding them would leave the surviving Undo wired to the first chat and
    // silently drop the second chat's undo affordance.
    const dup = toast.action
      ? undefined
      : get().toasts.find(
          (t) =>
            !t.action &&
            t.kind === toast.kind &&
            t.title === toast.title &&
            t.body === toast.body,
        );
    if (dup) {
      const timer = dismissTimers.get(dup.id);
      if (timer !== undefined) window.clearTimeout(timer);
      startDismissTimer(dup.id, ttlFor(dup), set);
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
      heldToasts.delete(evictedId);
    }
    set((s) => ({
      toasts: [...s.toasts.filter((t) => !evicted.has(t.id)), { id, ...toast }],
    }));
    startDismissTimer(id, ttlFor(toast), set);
    return id;
  },
  dismiss: (id) => {
    const timer = dismissTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimers.delete(id);
    }
    heldToasts.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  pause: (id, reason) => {
    const held = heldToasts.get(id) ?? new Set<HoldReason>();
    held.add(reason);
    heldToasts.set(id, held);
    const timer = dismissTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimers.delete(id);
    }
  },
  resume: (id, reason) => {
    const held = heldToasts.get(id);
    if (held) {
      held.delete(reason);
      // Someone else is still holding it — most often the pointer leaving a
      // chip whose Undo button has keyboard focus.
      if (held.size > 0) return;
      heldToasts.delete(id);
    }
    const toast = get().toasts.find((t) => t.id === id);
    if (toast) startDismissTimer(id, ttlFor(toast), set);
  },
  clear: () => {
    // Pull all pending timers so a `clear()` doesn't leave them firing
    // against a freshly-pushed toast that happens to reuse an id (very
    // unlikely with the time-plus-random format, but cheap to be safe).
    for (const timer of dismissTimers.values()) window.clearTimeout(timer);
    dismissTimers.clear();
    heldToasts.clear();
    set({ toasts: [] });
  },
}));
