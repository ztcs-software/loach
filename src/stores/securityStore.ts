import { create } from "zustand";
import {
  securityStatus,
  securityUnlock as backendUnlock,
  securityClear,
  securitySetup,
  securityGetHint,
  type LockStatus,
  type SecuritySetupArgs,
} from "@/lib/tauri";
import { logger } from "@/lib/logger";

interface SecurityState {
  /** Latest snapshot from the backend. `configured: false` until hydrate(). */
  status: LockStatus;
  /** Hydration ran and we know whether the app is configured for a lock. */
  hydrated: boolean;
  /** True once the user has cleared the lock screen. Stays true for the
   *  rest of the session. There's no auto-relock-on-idle yet — when we add
   *  one, this becomes a timer-driven boolean. */
  unlocked: boolean;

  hydrate: () => Promise<void>;
  /** Apply a fresh setup. Throws on backend validation errors so the form
   *  can surface them inline. */
  setup: (args: SecuritySetupArgs) => Promise<void>;
  /** Try the supplied credentials. Returns true on success and flips
   *  `unlocked` so the gate in App.tsx falls open. */
  unlock: (args: { pin?: string; password?: string }) => Promise<boolean>;
  /** Tear down the lock. Used by "Remove app lock" in Settings. Requires
   *  the user's CURRENT credentials so a compromised renderer can't disable
   *  the lock without authenticating first. */
  clear: (args?: { pin?: string; password?: string }) => Promise<void>;
  /** Backend reads the hint out of the (still secured) blob. We don't cache
   *  the hint in JS — that way the only path to it is an explicit click on
   *  "Show hint" on the lock screen. */
  getHint: () => Promise<string | null>;
}

const EMPTY_STATUS: LockStatus = {
  configured: false,
  method: null,
  pin_length: null,
  has_hint: false,
};

/** How long `hydrate` waits for the status probe before failing open. The
 *  probe is a single keyring read — normally milliseconds — so this only
 *  exists for a WEDGED call that never settles (a rejected one already takes
 *  the catch below). `hydrated` gates the entire UI in App.tsx, so a hung
 *  probe without a timeout would strand the user on the probing screen
 *  forever. */
const PROBE_TIMEOUT_MS = 5000;

export const useSecurityStore = create<SecurityState>((set, get) => ({
  status: EMPTY_STATUS,
  hydrated: false,
  // Start unlocked when no lock is configured. The initial hydrate() will
  // flip this back to false if a configured lock is found.
  unlocked: true,

  hydrate: async () => {
    // The timeout RESOLVES a sentinel rather than rejecting: a rejecting
    // loser would surface as an unhandled rejection (nothing awaits it once
    // the race settles) and trip the global toast net in main.tsx.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), PROBE_TIMEOUT_MS);
    });
    try {
      const status = await Promise.race([securityStatus(), timedOut]);
      if (status === "timed-out") {
        throw new Error(
          `security status probe still pending after ${PROBE_TIMEOUT_MS}ms`,
        );
      }
      set({
        status,
        hydrated: true,
        // First boot: if a lock is configured, the user has to unlock before
        // the main UI mounts. Re-hydrating after a setup keeps `unlocked` as
        // it was — the user just authenticated, no need to lock them out.
        unlocked: status.configured ? get().unlocked : true,
      });
    } catch (e) {
      // The status probe failed (e.g. no Secret Service / keyring backend on
      // a Linux box) or timed out (a wedged IPC call, routed here via the
      // race above). Fail OPEN: mark hydration done and treat the app as
      // unlocked + unconfigured rather than stranding the user on the probing
      // screen forever. App.tsx's hydration gate waits on `hydrated`, so a
      // never-settling probe would otherwise hang the entire app. The
      // app-lock is a render-gate over plaintext local data, not a
      // confidentiality boundary, so failing open costs no real secrecy —
      // whereas failing closed would lock the owner out of their own machine
      // with no recovery path (unlock also needs the keyring).
      logger.error("security status probe failed; continuing unlocked", e);
      set({ status: EMPTY_STATUS, hydrated: true, unlocked: true });
    } finally {
      clearTimeout(timer);
    }
  },

  setup: async (args) => {
    await securitySetup(args);
    const status = await securityStatus();
    // Setting up a lock while inside the running app implies the user is
    // already authenticated (they reached Settings). Don't kick them to
    // the lock screen until next launch / explicit re-lock.
    set({ status, hydrated: true, unlocked: true });
  },

  unlock: async ({ pin, password }) => {
    const ok = await backendUnlock({ pin, password });
    if (ok) set({ unlocked: true });
    return ok;
  },

  clear: async (args) => {
    await securityClear(args);
    set({ status: EMPTY_STATUS, unlocked: true });
  },

  getHint: () => securityGetHint(),
}));

/** Initial hydrate that App.tsx uses on cold start. We expose it as a
 *  separate function so the UI can also flip the locked flag synchronously
 *  before any backend call lands — avoiding a flash of the unlocked UI. */
export function lockUntilHydrated() {
  // Pessimistic: assume locked until status() resolves. If no lock is
  // configured, the hydrate() call clears this immediately.
  useSecurityStore.setState({ unlocked: false });
}
