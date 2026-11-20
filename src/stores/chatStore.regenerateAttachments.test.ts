// Regenerate resends the user turn's images. A chat loaded from disk lists
// them without their contents (`omitted`), so `regenerateLast` fetches them —
// before deleting the reply it replaces, so a failed read leaves that reply.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, Session } from "@/types";

const mocks = vi.hoisted(() => ({
  messageAttachments: vi.fn<typeof import("@/lib/tauri").messageAttachments>(),
  deleteMessage: vi.fn(() => Promise.resolve()),
  requests: [] as Array<{ messages: Array<{ images: string[] }> }>,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    messageAttachments: mocks.messageAttachments,
    deleteMessage: mocks.deleteMessage,
    appendMessage: vi.fn((args: { session_id: string; role: string; content: string }) =>
      Promise.resolve(msg("reply-2", args.role, args.content, null)),
    ),
    startChatStream: vi.fn((request: { stream_id: string; messages: Array<{ images: string[] }> }) => {
      mocks.requests.push(request);
      return Promise.resolve({
        streamId: request.stream_id,
        stop: () => Promise.resolve(),
        unlisten: () => undefined,
      });
    }),
  };
});

import { useChatStore, __testing } from "./chatStore";
import { useToastStore } from "./toastStore";

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
// The toast store calls `window.setTimeout`; the node environment has no `window`.
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

function msg(id: string, role: string, content: string, attachments: unknown): Message {
  return {
    id,
    session_id: "c1",
    role,
    content,
    thinking: null,
    attachments_json: attachments === null ? null : JSON.stringify(attachments),
    metrics_json: null,
    tool_calls_json: null,
    compacted_at: null,
    import_group: null,
    import_hidden: false,
    pinned_at: null,
    created_at: 1,
  } as unknown as Message;
}

const image = { kind: "image", name: "cat.png", mime: "image/png" };

describe("regenerateLast with a listed user turn", () => {
  beforeEach(() => {
    mocks.messageAttachments.mockReset();
    mocks.deleteMessage.mockClear();
    mocks.requests.length = 0;
    __testing.resetForTests();
    useToastStore.getState().clear();
    useChatStore.setState({
      sessions: [{ id: "c1", provider: "openai", model: "gpt-4o", params_json: null, space_id: null } as Session],
      activeSessionId: "c1",
      messages: {
        c1: [msg("u1", "user", "What is this?", [{ ...image, omitted: true }]), msg("r1", "assistant", "A cat.", null)],
      },
      streamingByMessage: {},
      runningTask: null,
      queue: [],
    } as never);
  });

  it("resends the images, fetched", async () => {
    mocks.messageAttachments.mockResolvedValue(JSON.stringify([{ ...image, data: "iVBORw0K" }]));
    await useChatStore.getState().regenerateLast("c1");
    expect(mocks.messageAttachments).toHaveBeenCalledWith("c1", "u1");
    expect(mocks.requests).toHaveLength(1);
    expect(mocks.requests[0].messages.at(-1)?.images).toEqual(["iVBORw0K"]);
  });

  it("keeps the reply when the images can't be read", async () => {
    mocks.messageAttachments.mockRejectedValue(new Error("database is locked"));
    await useChatStore.getState().regenerateLast("c1");
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
    expect(mocks.requests).toHaveLength(0);
    expect(useChatStore.getState().messages.c1.map((m) => m.id)).toEqual(["u1", "r1"]);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Couldn't regenerate");
  });
});
