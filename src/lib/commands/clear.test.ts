// `/clear` after a compaction.
//
// `compactContext` parks its summary in `session.system_prompt`, where it
// stands in for the turns it replaced. Clearing removed the turns but left
// the summary, which kept being sent; and a compaction still running would
// write it back over the emptied chat.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Message, Session } from "@/types";

const updateSessionSystemPrompt = vi.hoisted(() =>
  vi.fn(async (_args: { id: string; prompt: string }) => {}),
);
const clearSessionMessages = vi.hoisted(() => vi.fn(async (_sessionId: string) => {}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, updateSessionSystemPrompt, clearSessionMessages };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { SUMMARY_END_TAG, SUMMARY_START_TAG } from "@/lib/contextUsage";

const deps = { confirm: async () => true };

const SUMMARY_BLOCK = `${SUMMARY_START_TAG}\n- User is filing jointly\n${SUMMARY_END_TAG}\n\n`;

function openChat(system_prompt: string | null, compacting = false) {
  useChatStore.setState({
    sessions: [{ id: "chat-1", space_id: null, title: "Taxes", system_prompt } as Session],
    activeSessionId: "chat-1",
    messages: { "chat-1": [{ id: "m1", role: "user" } as Message] },
    compactingSessionId: compacting ? "chat-1" : null,
    cancelForSession: vi.fn(async () => {}),
  });
}

function storedPrompt(): string | null {
  return useChatStore.getState().sessions[0]!.system_prompt;
}

describe("/clear", () => {
  beforeEach(() => {
    updateSessionSystemPrompt.mockClear();
    clearSessionMessages.mockClear();
  });

  it("drops the compaction summary and keeps the user's instructions", async () => {
    openChat(`${SUMMARY_BLOCK}Be terse.`);
    const outcome = await dispatch("/clear", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Cleared chat" } });
    expect(clearSessionMessages).toHaveBeenCalledWith("chat-1");
    expect(updateSessionSystemPrompt).toHaveBeenCalledWith({ id: "chat-1", prompt: "Be terse." });
    expect(storedPrompt()).toBe("Be terse.");
    expect(useChatStore.getState().messages["chat-1"]).toEqual([]);
  });

  it("leaves instructions without a summary alone", async () => {
    openChat("Be terse.");
    await dispatch("/clear", deps);
    expect(clearSessionMessages).toHaveBeenCalledWith("chat-1");
    expect(updateSessionSystemPrompt).not.toHaveBeenCalled();
    expect(storedPrompt()).toBe("Be terse.");
  });

  it("refuses while this chat is being compacted", async () => {
    openChat(`${SUMMARY_BLOCK}Be terse.`, true);
    const outcome = await dispatch("/clear", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(clearSessionMessages).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages["chat-1"]).toHaveLength(1);
  });
});
