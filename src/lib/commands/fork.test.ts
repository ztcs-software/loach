// `/fork` copies what's on disk, and a reply's row stays empty until its
// stream finishes — so a fork taken mid-reply, or while a send is still being
// prepared, got an empty answer. The header's Fork waits; so does `/fork`.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";

const preparing = vi.hoisted(() => new Set<string>());

vi.mock("@/stores/chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/chatStore")>();
  return { ...actual, isPreparingSend: (id: string) => preparing.has(id) };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

const fork = vi.fn(async (_sourceId: string) => ({ id: "chat-2", title: "Copy" }) as Session);

describe("/fork", () => {
  beforeEach(() => {
    fork.mockClear();
    preparing.clear();
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null } as Session],
      activeSessionId: "chat-1",
      streamingSessionId: null,
      fork,
    });
  });

  it("waits for this chat's reply to finish", async () => {
    useChatStore.setState({ streamingSessionId: "chat-1" });
    const outcome = await dispatch("/fork", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(fork).not.toHaveBeenCalled();
  });

  it("waits for a send still being prepared", async () => {
    preparing.add("chat-1");
    const outcome = await dispatch("/fork", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(fork).not.toHaveBeenCalled();
  });

  it("forks an idle chat, whatever another chat is doing", async () => {
    useChatStore.setState({ streamingSessionId: "chat-9" });
    const outcome = await dispatch("/fork", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Forked chat" } });
    expect(fork).toHaveBeenCalledWith("chat-1");
  });
});
