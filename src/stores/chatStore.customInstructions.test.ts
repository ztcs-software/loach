// The global Custom instructions in a compacted chat.
//
// `buildTaskRequest` falls back to the global Custom instructions when a chat
// has none of its own. `compactContext` parks its summary in the per-chat
// `system_prompt`, and the fallback used to test that field as a whole — so a
// chat with no instructions of its own (never set, or `/instructions clear`)
// stopped following the global ones the moment it was compacted.

import { describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";

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

const summaryBlock = `${SUMMARY_START_TAG}\n- User is filing jointly\n${SUMMARY_END_TAG}`;

/** A chat whose per-chat prompt is `ownPrompt`, after `compactContext` has
 *  written its summary in front of it. */
function compactedChat(ownPrompt: string, spaceId: string | null = null): Session {
  return {
    id: "chat-1",
    title: "Chat",
    provider: "ollama",
    model: "m",
    system_prompt: `${summaryBlock}\n\n${ownPrompt}`,
    params_json: null,
    space_id: spaceId,
    pinned_at: null,
    archived_at: null,
    forked_from_session_id: null,
    label: null,
    folder_id: null,
    workspace_root: null,
    created_at: 0,
    updated_at: 0,
  } as Session;
}

async function systemPromptFor(session: Session) {
  useSettingsStore.setState({
    global_system_prompt: "Reply in Polish.",
    global_memory_enabled: false,
    temporal_awareness: false,
  });
  const request = await __testing.buildTaskRequest(session, session.id, [], "hi", []);
  return request.system_prompt;
}

describe("global Custom instructions after compaction", () => {
  it("still apply to a chat with no instructions of its own", async () => {
    expect(await systemPromptFor(compactedChat(""))).toBe(
      `${summaryBlock}\n\nReply in Polish.`,
    );
  });

  it("still yield to the chat's own instructions", async () => {
    expect(await systemPromptFor(compactedChat("Be terse."))).toBe(
      `${summaryBlock}\n\nBe terse.`,
    );
  });

  it("still yield to the Space's instructions", async () => {
    expect(await systemPromptFor(compactedChat("", "space-1"))).toBe(
      `${summaryBlock}\n\nAnswer as a tax adviser.`,
    );
  });
});
