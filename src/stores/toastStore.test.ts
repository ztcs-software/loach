// Coverage for the toast auto-dismiss lifecycle:
//
//   - kind-based TTL: error toasts (10s) outlive info-grade ones (4s)
//   - `durationMs` overrides the kind default (the archive Undo chip)
//   - pause holds a toast past its TTL; resume re-arms a full window
//   - a duplicate push while held must NOT re-arm the sweep — the chip
//     would otherwise vanish under the cursor of whoever is reading it
//
// The store calls `window.setTimeout` / `window.clearTimeout`; the node test
// environment has no `window`, so delegate lazily to the globals (which
// vi.useFakeTimers patches) — same trick the streaming tests use for rAF.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

import { useToastStore } from "./toastStore";

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toast auto-dismiss", () => {
  it("errors outlive info-grade toasts (kind-based TTL)", () => {
    useToastStore.getState().push({ kind: "info", title: "Copied" });
    useToastStore.getState().push({ kind: "error", title: "Couldn't reach Ollama" });

    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
      "Couldn't reach Ollama",
    ]);

    vi.advanceTimersByTime(6000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("durationMs overrides the kind default", () => {
    useToastStore
      .getState()
      .push({ kind: "info", title: "Moved to archive", durationMs: 7000 });

    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(3000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("pause holds past the TTL and resume re-arms a full window", () => {
    const id = useToastStore.getState().push({ kind: "info", title: "Copied" });
    useToastStore.getState().pause(id);

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resume(id);
    vi.advanceTimersByTime(3999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("a duplicate push while held does not re-arm the sweep", () => {
    const id = useToastStore.getState().push({ kind: "error", title: "boom" });
    useToastStore.getState().pause(id);

    // Coalesces onto the held toast; must not start a fresh timer.
    useToastStore.getState().push({ kind: "error", title: "boom" });
    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resume(id);
    vi.advanceTimersByTime(10_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
