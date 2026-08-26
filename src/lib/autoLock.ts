//! Auto-lock triggers for a configured app lock.
//!
//! The app lock itself (`securityStore` + `security.rs`) only gates *launch*:
//! once you clear the lock screen you stay unlocked for the life of the
//! process. That makes it a boot gate rather than a control over the threat
//! people actually have — walking away from an unlocked machine. The two
//! triggers here re-engage it mid-session, both opt-in:
//!
//!   - `lock_idle_timeout` — no pointer / key / wheel / touch activity for N
//!     minutes.
//!   - `lock_on_hide` — the window was minimized or otherwise hidden.
//!
//! Neither needs the backend: `lock()` flips a render gate, and the
//! credentials were never in the renderer to begin with.

import { useEffect } from "react";
import { useSecurityStore } from "@/stores/securityStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { LockIdleTimeout } from "@/types";

/** Each `lock_idle_timeout` choice as milliseconds. `off` is 0, which every
 *  caller reads as "don't arm the idle trigger at all". */
export const IDLE_MS: Record<LockIdleTimeout, number> = {
  off: 0,
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
};

/** What counts as "the user is still here". Listened for in the capture
 *  phase so a component that stops propagation (the composer swallows some
 *  keydowns) can't make the app look idle while someone is typing into it. */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** How often the idle deadline is re-checked.
 *
 *  A deadline + poll rather than one long `setTimeout(idleMs)` because a
 *  single long timer gets both of its failure modes from the environment:
 *  Chromium throttles timers in a backgrounded window (so it fires late and
 *  unpredictably), and a machine that suspends mid-countdown resumes with the
 *  timer still owing its full remaining wall-clock. Comparing `Date.now()`
 *  against a stored deadline is immune to both — a laptop that sleeps for an
 *  hour is over any threshold the moment it wakes.
 *
 *  The cost is granularity: the lock lands somewhere in
 *  `[idleMs, idleMs + IDLE_POLL_MS)`. Erring late is the safe direction and
 *  15 s is inside the noise for a 1-minute floor. */
const IDLE_POLL_MS = 15_000;

/**
 * Wire up whichever triggers are enabled and return a teardown. Split out of
 * the hook so it can be exercised without a React renderer — see
 * `autoLock.test.ts`.
 */
export function startAutoLock({
  idleMs,
  onHide,
  lock,
}: {
  idleMs: number;
  onHide: boolean;
  lock: () => void;
}): () => void {
  const teardown: Array<() => void> = [];

  if (idleMs > 0) {
    let lastActivity = Date.now();
    const bump = () => {
      lastActivity = Date.now();
    };
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, bump, { passive: true, capture: true });
      teardown.push(() =>
        window.removeEventListener(type, bump, { capture: true }),
      );
    }
    const poll = window.setInterval(() => {
      if (Date.now() - lastActivity >= idleMs) lock();
    }, IDLE_POLL_MS);
    teardown.push(() => window.clearInterval(poll));
  }

  if (onHide) {
    // `visibilitychange` rather than window focus on purpose. A native save /
    // open dialog — export, import, the attachment picker — takes focus but
    // leaves the document visible, so a focus-based trigger would relock the
    // app every time someone attached a file. Minimizing does flip
    // visibility, which is the intent we actually want to catch.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") lock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    teardown.push(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
  }

  return () => {
    for (const off of teardown) off();
  };
}

/**
 * Mounted once from `App`. Arms the triggers only while there is something to
 * re-lock — a configured lock, currently unlocked — so the listeners don't
 * exist at all for the majority of users who never set a lock up.
 */
export function useAutoLock() {
  const configured = useSecurityStore((s) => s.status.configured);
  const unlocked = useSecurityStore((s) => s.unlocked);
  const timeout = useSettingsStore((s) => s.lock_idle_timeout);
  const onHide = useSettingsStore((s) => s.lock_on_hide);

  useEffect(() => {
    if (!configured || !unlocked) return;
    // `?? 0` guards a value written by a newer build and read back by an
    // older one — the settings KV table has no schema to reject it.
    const idleMs = IDLE_MS[timeout] ?? 0;
    if (idleMs === 0 && !onHide) return;
    return startAutoLock({
      idleMs,
      onHide,
      lock: () => useSecurityStore.getState().lock(),
    });
  }, [configured, unlocked, timeout, onHide]);
}
