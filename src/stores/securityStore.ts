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
  /** Tear down the lock. Used by "Remove app lock" in Settings. */
  clear: () => Promise<void>;
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

export const useSecurityStore = create<SecurityState>((set, get) => ({
  status: EMPTY_STATUS,
  hydrated: false,
  // Start unlocked when no lock is configured. The initial hydrate() will
  // flip this back to false if a configured lock is found.
  unlocked: true,

  hydrate: async () => {
    const status = await securityStatus();
    set({
      status,
      hydrated: true,
      // First boot: if a lock is configured, the user has to unlock before
      // the main UI mounts. Re-hydrating after a setup keeps `unlocked` as
      // it was — the user just authenticated, no need to lock them out.
      unlocked: status.configured ? get().unlocked : true,
    });
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

  clear: async () => {
    await securityClear();
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
