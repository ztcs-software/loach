// `/stop` has the composer Stop button's scope: the running reply or queued
// prompt of the chat it's typed in, never another chat's stream.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";
import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

const cancelForSession = vi.fn(async (_sessionId: string) => {});

function openChat(state: { running?: string; queued?: string }) {
  useChatStore.setState({
    sessions: [
      { id: "chat-1", space_id: null } as Session,
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
});
