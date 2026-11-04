// `/stop` has the composer Stop button's scope: the running reply or queued
// prompt of the chat it's typed in, never another chat's stream. A send still
// building its request (neither running nor queued yet) counts too, and
// `/regenerate` says so instead of silently doing nothing.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Message, Session } from "@/types";

const preparing = vi.hoisted(() => new Set<string>());

vi.mock("@/stores/chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/chatStore")>();
  return { ...actual, isPreparingSend: (id: string) => preparing.has(id) };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

const cancelForSession = vi.fn(async (_sessionId: string) => {});

function openChat(state: { running?: string; queued?: string }) {
  useChatStore.setState({
    sessions: [
      { id: "chat-1", space_id: null, model: "llama3" } as Session,
      { id: "chat-2", space_id: null } as Session,
    ],
    activeSessionId: "chat-1",
    runningTask: state.running
      ? ({ id: "t-run", sessionId: state.running } as never)
      : null,
    queue: state.queued ? [{ id: "t-wait", sessionId: state.queued } as never] : [],
    cancelForSession,
  });
}

describe("/stop", () => {
  beforeEach(() => {
    cancelForSession.mockClear();
    preparing.clear();
  });

  it("stops this chat's running reply", async () => {
    openChat({ running: "chat-1" });
    const outcome = await dispatch("/stop", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Stopped reply" } });
    expect(cancelForSession).toHaveBeenCalledWith("chat-1");
  });

  it("removes this chat's queued prompt", async () => {
    openChat({ running: "chat-2", queued: "chat-1" });
    const outcome = await dispatch("/stop", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Removed queued prompt" } });
    expect(cancelForSession).toHaveBeenCalledWith("chat-1");
  });

  it("leaves another chat's stream alone", async () => {
    openChat({ running: "chat-2" });
    const outcome = await dispatch("/stop", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Nothing to stop" } });
    expect(cancelForSession).not.toHaveBeenCalled();
  });

  it("stops this chat's send while it is still being prepared", async () => {
    openChat({ running: "chat-2" });
    preparing.add("chat-1");
    const outcome = await dispatch("/stop", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Stopped reply" } });
    expect(cancelForSession).toHaveBeenCalledWith("chat-1");
  });
});

describe("/regenerate while a send is being prepared", () => {
  it("says so instead of doing nothing", async () => {
    openChat({});
    useChatStore.setState({
      messages: {
        "chat-1": [
          { id: "m1", role: "user" } as Message,
          { id: "m2", role: "assistant", import_group: null } as Message,
        ],
      },
    });
    preparing.add("chat-1");
    const regenerateLast = vi.fn(async (_sessionId: string) => {});
    useChatStore.setState({ regenerateLast });
    const outcome = await dispatch("/regenerate", deps);
    expect(outcome).toMatchObject({
      result: { kind: "toast", tone: "error", body: expect.stringContaining("still being prepared") },
    });
    expect(regenerateLast).not.toHaveBeenCalled();
  });
});
