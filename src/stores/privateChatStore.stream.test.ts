// Private Chat's stream across its connect window — the time between asking
// the backend for a stream and getting its handle back.
//
//   - Stop in that window did nothing: there was no handle yet to stop.
//   - A stream that ended in that window (a fast error) was torn down, and
//     its dead handle installed afterwards — stale, listener still attached.
//   - Closing the overlay, reopening it and sending again in that window let
//     the old stream's tokens land in the new conversation.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  interface FakeStream {
    onEvent: (ev: unknown) => void;
    resolve: () => void;
    stopped: boolean;
    unlistened: boolean;
  }
  return { streams: [] as FakeStream[] };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    startChatStream: vi.fn((request: { stream_id: string }, onEvent: (ev: unknown) => void) => {
      const entry = { onEvent, stopped: false, unlistened: false } as (typeof mocks.streams)[number];
      mocks.streams.push(entry);
      return new Promise((resolve) => {
        entry.resolve = () =>
          resolve({
            streamId: request.stream_id,
            stop: async () => {
              entry.stopped = true;
            },
            unlisten: () => {
              entry.unlistened = true;
            },
          });
      });
    }),
  };
});

import { usePrivateChatStore } from "./privateChatStore";

// Node has no requestAnimationFrame; the batched flush needs one.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

const store = () => usePrivateChatStore.getState();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const reply = () => store().messages.find((m) => m.role === "assistant");

beforeEach(() => {
  mocks.streams.length = 0;
  store().wipe();
  usePrivateChatStore.setState({ open: true, model: "m" });
});

describe("Private Chat connect window", () => {
  it("Stop works before the stream has connected", async () => {
    const sending = store().send("hi", []);
    await tick();
    await store().cancel();
    expect(store().isStreaming).toBe(false);

    // The handle arrives after the Stop: the stream is stopped, not adopted,
    // and what it still sends is dropped.
    mocks.streams[0].resolve();
    await sending;
    expect(mocks.streams[0].stopped).toBe(true);
    expect(mocks.streams[0].unlistened).toBe(true);
    expect(store().activeStream).toBeNull();
    mocks.streams[0].onEvent({ kind: "token", delta: "late" });
    await tick();
    expect(reply()?.content).toBe("");
  });

  it("doesn't install the handle of a stream that already ended", async () => {
    const sending = store().send("hi", []);
    await tick();
    mocks.streams[0].onEvent({ kind: "error", message: "boom" });
    expect(store().isStreaming).toBe(false);

    mocks.streams[0].resolve();
    await sending;
    expect(store().activeStream).toBeNull();
    expect(mocks.streams[0].unlistened).toBe(true);
  });

  it("keeps a closed conversation's stream out of the next one", async () => {
    const first = store().send("secret", []);
    await tick();
    store().wipe();
    usePrivateChatStore.setState({ open: true, model: "m" });
    const second = store().send("hello", []);
    await tick();

    mocks.streams[0].onEvent({ kind: "token", delta: "OLD" });
    mocks.streams[0].onEvent({ kind: "done" });
    mocks.streams[1].onEvent({ kind: "token", delta: "new" });
    await tick();
    // The old stream's `done` didn't end the new reply either.
    expect(store().isStreaming).toBe(true);
    expect(reply()?.content).toBe("new");

    mocks.streams[0].resolve();
    mocks.streams[1].resolve();
    await Promise.all([first, second]);
    expect(mocks.streams[0].stopped).toBe(true);
    expect(store().activeStream).not.toBeNull();
  });
});
