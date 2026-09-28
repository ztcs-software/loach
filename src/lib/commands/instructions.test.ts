// `/instructions <text>` and `/instructions clear` after a compaction.
//
// `compactContext` parks the summary in `session.system_prompt` and
// `chatHistory` stops sending the turns it replaced. Both command forms used
// to overwrite the whole field, so the summary went too — the model then saw
// neither the summary nor those turns, and nothing told the user.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";

const updateSessionSystemPrompt = vi.hoisted(() =>
  vi.fn(async (_args: { id: string; prompt: string }) => {}),
);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, updateSessionSystemPrompt };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import {
  extractSummary,
  stripSummaryBlock,
  SUMMARY_END_TAG,
  SUMMARY_START_TAG,
} from "@/lib/contextUsage";

const deps = { confirm: async () => true };

const SUMMARY_BLOCK = `${SUMMARY_START_TAG}\n- User is filing jointly\n${SUMMARY_END_TAG}\n\n`;

function openChat(system_prompt: string | null) {
  useChatStore.setState({
    sessions: [{ id: "chat-1", space_id: null, system_prompt } as Session],
    activeSessionId: "chat-1",
  });
}

function storedPrompt(): string {
  return useChatStore.getState().sessions[0]!.system_prompt ?? "";
}

describe("/instructions after a compaction", () => {
  beforeEach(() => {
    updateSessionSystemPrompt.mockClear();
  });

  it("replaces only the user's own text and keeps the summary", async () => {
    openChat(`${SUMMARY_BLOCK}Be terse.`);
    const outcome = await dispatch("/instructions Answer in French.", deps);
    expect(outcome).toMatchObject({
      kind: "handled",
      result: { kind: "toast", title: "Saved instructions" },
    });
    const prompt = `${SUMMARY_BLOCK}Answer in French.`;
    expect(updateSessionSystemPrompt).toHaveBeenCalledWith({ id: "chat-1", prompt });
    expect(storedPrompt()).toBe(prompt);
  });

  it("clears only the user's own text and keeps the summary", async () => {
    openChat(`${SUMMARY_BLOCK}Be terse.`);
    const outcome = await dispatch("/instructions clear", deps);
    expect(outcome).toMatchObject({
      kind: "handled",
      result: { kind: "toast", title: "Cleared instructions" },
    });
    expect(extractSummary(storedPrompt())).toBe("- User is filing jointly");
    expect(stripSummaryBlock(storedPrompt())).toBe("");
    // Bare `/instructions` reports nothing of the user's own left.
    expect(await dispatch("/instructions", deps)).toMatchObject({
      result: { kind: "toast", title: "No instructions set" },
    });
  });

  it("still writes plain text when there is no summary", async () => {
    openChat("Be terse.");
    await dispatch("/instructions Answer in French.", deps);
    expect(storedPrompt()).toBe("Answer in French.");
    await dispatch("/instructions clear", deps);
    expect(storedPrompt()).toBe("");
  });
});
