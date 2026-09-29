// The memory blocks `buildTaskRequest` adds to a chat's system prompt.
//
// A Space chat whose Space context fails to load (a transient read error)
// used to lose the global-memory block along with it, though the global
// facts don't depend on the Space at all.

import { describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getSpaceContext: vi.fn(async () => {
      throw new Error("database is busy");
    }),
    listGlobalMemories: vi.fn(async () => [
      {
        id: "g1",
        content: "Prefers metric units",
        source_session_id: null,
        source_message_id: null,
        created_at: 1,
        updated_at: 1,
      },
    ]),
  };
});

import { __testing } from "./chatStore";
import { useSettingsStore } from "./settingsStore";

const session = {
  id: "chat-1",
  title: "Chat",
  provider: "ollama",
  model: "m",
  system_prompt: "Be brief.",
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

describe("memory in the system prompt", () => {
  it("keeps global memory in a Space chat whose Space context didn't load", async () => {
    useSettingsStore.setState({ global_memory_enabled: true, temporal_awareness: false });
    const request = await __testing.buildTaskRequest(session, session.id, [], "hi", []);
    expect(request.system_prompt).toContain("Be brief.");
    expect(request.system_prompt).toContain("- Prefers metric units");
  });
});
