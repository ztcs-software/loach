// Coverage for the auto-lock triggers (`lock_idle_timeout` / `lock_on_hide`).
//
// The interesting behaviour is timing, and it has an exact contract worth
// pinning: the idle deadline is measured against wall-clock (`Date.now()`)
// and polled, so activity has to push the deadline out and a long jump
// forward has to trip it. A `setTimeout`-based implementation passes the
// "fires eventually" assertion but silently loses the suspend/throttle
// behaviour, so the tests below advance in steps rather than in one leap.
//
// `startAutoLock` reads `window` / `document` from globals. The vitest env is
// `node`, so both are shimmed here — the same in-test shim approach the
// streaming-store tests use for `requestAnimationFrame`.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { IDLE_MS, startAutoLock } from "./autoLock";

type Handler = () => void;

function makeTarget() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    addEventListener(type: string, fn: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(fn);
      handlers.set(type, set);
    },
    removeEventListener(type: string, fn: Handler) {
      handlers.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn();
    },
    total() {
      let n = 0;
      for (const set of handlers.values()) n += set.size;
      return n;
    },
  };
}

const globals = globalThis as unknown as Record<string, unknown>;

let win: ReturnType<typeof makeTarget>;
let doc: ReturnType<typeof makeTarget> & { visibilityState: string };
let lock: Mock<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  win = makeTarget();
  doc = Object.assign(makeTarget(), { visibilityState: "visible" });
  lock = vi.fn<() => void>();
  globals.window = {
    ...win,
    // Delegate rather than capture, so vitest's fake timers (installed above,
    // and re-installed per test) are the ones actually used.
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id: number) => globalThis.clearInterval(id),
  };
  globals.document = doc;
});

afterEach(() => {
  vi.useRealTimers();
  delete globals.window;
  delete globals.document;
});

describe("startAutoLock — idle", () => {
  it("does not lock before the deadline, and does after", () => {
    startAutoLock({ idleMs: IDLE_MS["1m"], onHide: false, lock });

    vi.advanceTimersByTime(45_000);
    expect(lock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(lock).toHaveBeenCalled();
  });

  it("pushes the deadline out on activity", () => {
    startAutoLock({ idleMs: IDLE_MS["1m"], onHide: false, lock });

    vi.advanceTimersByTime(45_000);
    win.fire("pointermove");

    // 90 s in absolute terms, but only 45 s since the last activity.
    vi.advanceTimersByTime(45_000);
    expect(lock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(lock).toHaveBeenCalled();
  });

  it("stays disarmed when the timeout is off", () => {
    const stop = startAutoLock({ idleMs: IDLE_MS.off, onHide: false, lock });

    expect(win.total()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(lock).not.toHaveBeenCalled();
    stop();
  });
});

describe("startAutoLock — hide", () => {
  it("locks when the document becomes hidden", () => {
    startAutoLock({ idleMs: 0, onHide: true, lock });

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");

    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("ignores the visible half of the event", () => {
    // Restoring the window fires `visibilitychange` too; only the hidden
    // transition is a trigger.
    startAutoLock({ idleMs: 0, onHide: true, lock });

    doc.fire("visibilitychange");

    expect(lock).not.toHaveBeenCalled();
  });
});

describe("startAutoLock — teardown", () => {
  it("removes every listener and stops polling", () => {
    const stop = startAutoLock({
      idleMs: IDLE_MS["1m"],
      onHide: true,
      lock,
    });
    expect(win.total()).toBeGreaterThan(0);
    expect(doc.total()).toBe(1);

    stop();

    expect(win.total()).toBe(0);
    expect(doc.total()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(lock).not.toHaveBeenCalled();
  });
});
