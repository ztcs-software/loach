// The compaction summary in a Space chat that has its own instructions.
//
// `compactContext` parks the summary in the per-chat `system_prompt` and
// `chatHistory` stops sending the compacted turns. Space instructions
// replace that per-chat prompt, so they used to replace the summary too —
// the model then saw neither the summary nor the turns it stands in for.

import { describe, it, expect, vi } from "vitest";
import type { Message, Session } from "@/types";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getSpaceContext: vi.fn(async () => ({
      space: {
        id: "space-1",
        name: "Space",
        description: "",
        instructions: "Answer as a tax adviser.",
        default_provider: null,
        default_model: null,
        default_params_json: null,
        memory_enabled: false,
        created_at: 0,
        updated_at: 0,
      },
      files: [],
      memories: [],
    })),
  };
});

import { __testing } from "./chatStore";
import { useSettingsStore } from "./settingsStore";
import { SUMMARY_END_TAG, SUMMARY_START_TAG } from "@/lib/contextUsage";

const session = {
  id: "chat-1",
  title: "Chat",
  provider: "ollama",
  model: "m",
  system_prompt: `${SUMMARY_START_TAG}\n- User is filing jointly\n${SUMMARY_END_TAG}\n\nBe terse.`,
  params_json: null,
  space_id: "space-1",
  pinned_at: null,
  archived_at: null,
  forked_from_session_id: null,
  label: null,
  folder_id: null,
  workspace_root: null,
  created_at: 0,
  updated_at: 0,
} as Session;

const compacted = {
  id: "m1",
  session_id: session.id,
  role: "user",
  content: "We're filing jointly this year.",
  compacted_at: 5,
} as Message;

describe("compaction summary in a Space chat", () => {
  it("survives the Space instructions overriding the per-chat prompt", async () => {
    useSettingsStore.setState({ global_memory_enabled: false, temporal_awareness: false });
    const request = await __testing.buildTaskRequest(session, session.id, [compacted], "hi", []);
    expect(request.system_prompt).toContain(
      `${SUMMARY_START_TAG}\n- User is filing jointly\n${SUMMARY_END_TAG}`,
    );
    expect(request.system_prompt).toContain("Answer as a tax adviser.");
    // The documented override still holds for the user's own instructions.
    expect(request.system_prompt).not.toContain("Be terse.");
    expect(request.messages.map((m) => m.content)).toEqual(["hi"]);
  });
});
