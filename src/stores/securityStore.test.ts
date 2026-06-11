// Regression coverage for the security-probe hydration gate (commit e5f3333,
// "gate app hydration on the security probe and fail open when it errors").
//
// App.tsx blocks the whole UI on `hydrated`, and the lock screen on
// `unlocked` — so this little state machine can fail two opposite ways:
// a probe error that never sets `hydrated` strands the user on the probing
// screen forever, while careless error handling that flips `unlocked` for a
// CONFIGURED lock turns fail-open into fail-unlocked. Pin both directions.
//
// `securityStatus` is the only wrapper mocked; everything else in
// `@/lib/tauri` already no-ops outside the Tauri shell.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, securityStatus: vi.fn() };
});

import { securityStatus, type LockStatus } from "@/lib/tauri";
import { useSecurityStore, lockUntilHydrated } from "./securityStore";

const probe = vi.mocked(securityStatus);

const UNCONFIGURED: LockStatus = {
  configured: false,
  method: null,
  pin_length: null,
  has_hint: false,
};
const PIN_LOCK: LockStatus = {
  configured: true,
  method: "pin",
  pin_length: 6,
  has_hint: false,
};

beforeEach(() => {
  probe.mockReset();
  useSecurityStore.setState({
    status: UNCONFIGURED,
    hydrated: false,
    unlocked: true,
  });
});

describe("securityStore hydration", () => {
  it("fails open when the status probe rejects", async () => {
    // Cold start: App.tsx pessimistically locks before the probe lands.
    lockUntilHydrated();
    expect(useSecurityStore.getState().unlocked).toBe(false);

    // e.g. no Secret Service / keyring backend on a bare Linux box.
    probe.mockRejectedValueOnce(new Error("no keyring backend"));
    await useSecurityStore.getState().hydrate();

    const s = useSecurityStore.getState();
    expect(s.hydrated).toBe(true); // App.tsx's gate must open…
    expect(s.unlocked).toBe(true); // …onto the app, not onto a dead lock screen
    expect(s.status.configured).toBe(false);
  });

  it("fails open when the status probe hangs", async () => {
    // A wedged IPC call that never settles — rejection is covered above;
    // this pins the timeout path (`PROBE_TIMEOUT_MS` race in hydrate()).
    vi.useFakeTimers();
    try {
      lockUntilHydrated();
      probe.mockReturnValueOnce(new Promise<never>(() => {}));
      const hydration = useSecurityStore.getState().hydrate();
      await vi.advanceTimersByTimeAsync(5000);
      await hydration;

      const s = useSecurityStore.getState();
      expect(s.hydrated).toBe(true);
      expect(s.unlocked).toBe(true);
      expect(s.status.configured).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays locked on cold start when a lock is configured", async () => {
    // Fail-open must not leak into the success path: a configured lock on
    // first boot keeps the pessimistic `unlocked: false`.
    lockUntilHydrated();
    probe.mockResolvedValueOnce(PIN_LOCK);
    await useSecurityStore.getState().hydrate();

    const s = useSecurityStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.unlocked).toBe(false);
    expect(s.status).toEqual(PIN_LOCK);
  });

  it("does not relock a user who already authenticated", async () => {
    // Re-hydrate after setup/unlock: `unlocked` was true and must survive
    // the probe reporting a configured lock.
    useSecurityStore.setState({ unlocked: true });
    probe.mockResolvedValueOnce(PIN_LOCK);
    await useSecurityStore.getState().hydrate();

    expect(useSecurityStore.getState().unlocked).toBe(true);
  });

  it("clears the pessimistic lock when no lock is configured", async () => {
    lockUntilHydrated();
    probe.mockResolvedValueOnce(UNCONFIGURED);
    await useSecurityStore.getState().hydrate();

    const s = useSecurityStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.unlocked).toBe(true);
  });
});
