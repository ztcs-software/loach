// `/remember` in a Space honours the Space's memory toggle.
//
// With the toggle off, auto-extraction stopped and the Memory tab's Add was
// disabled, but `/remember` still wrote into the Space.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Session, Space } from "@/types";

const addSpaceMemory = vi.hoisted(() =>
  vi.fn(async (args: { space_id: string; content: string }) => ({
    id: "m1",
    space_id: args.space_id,
    content: args.content,
    source_session_id: null,
    source_message_id: null,
    created_at: 1,
    updated_at: 1,
  })),
);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, addSpaceMemory };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";

const deps = { confirm: async () => true };

function openSpaceChat(memory_enabled: boolean) {
  useSpaceStore.setState({
    spaces: [{ id: "space-1", name: "Work", memory_enabled } as Space],
  });
  useChatStore.setState({
    sessions: [{ id: "chat-1", space_id: "space-1" } as Session],
    activeSessionId: "chat-1",
  });
}

describe("/remember in a Space", () => {
  beforeEach(() => {
    addSpaceMemory.mockClear();
  });

  it("refuses when the Space's memory is off", async () => {
    openSpaceChat(false);
    const outcome = await dispatch("/remember Prefers tabs", deps);
    expect(outcome).toMatchObject({
      kind: "handled",
      result: { kind: "toast", tone: "error" },
    });
    expect(addSpaceMemory).not.toHaveBeenCalled();
  });

  it("saves when the Space's memory is on", async () => {
    openSpaceChat(true);
    const outcome = await dispatch("/remember Prefers tabs", deps);
    expect(outcome).toMatchObject({
      kind: "handled",
      result: { kind: "toast", title: "Saved to memory" },
    });
    expect(addSpaceMemory).toHaveBeenCalledWith(
      expect.objectContaining({ space_id: "space-1", content: "Prefers tabs" }),
    );
  });
});
