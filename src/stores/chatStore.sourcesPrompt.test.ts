// Library sources in the system prompt are the user's material, not
// instructions — so the template pass must leave them alone.
//
// `buildTaskRequest` used to join the full-text sources block into the
// system prompt before substituting `{{USER_NAME}}` and the temporal
// placeholders. A stored prompt template saved in the Library was rewritten
// on its way to the model, and a source mentioning `{{CURRENT_DATE}}` also
// counted as the author placing the date by hand, so the chat lost its
// "Current date" line.

import { describe, it, expect, vi } from "vitest";
import type { LibraryItem, LibraryItemMeta, Session } from "@/types";

const BODY = "Template: Dear {{USER_NAME}}, as of {{CURRENT_DATE}} your order shipped.";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    libraryListSources: vi.fn(async () => []),
    libraryGetItems: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, title: "Order email", content: BODY, updated_at: 1 }) as unknown as LibraryItem),
    ),
  };
});

import { __testing } from "./chatStore";
import { useLibraryStore } from "./libraryStore";
import { useSettingsStore } from "./settingsStore";

const item = {
  id: "tpl",
  kind: "text",
  title: "Order email",
  mime: "text/markdown",
  media: "text",
  size: BODY.length,
  chars: BODY.length,
  preview: "",
  url: null,
  fetched_at: null,
  content_hash: "tpl",
  truncated: false,
  chunks: 1,
  embedded: 0,
  created_at: 1,
  updated_at: 1,
} satisfies LibraryItemMeta;

const chat = {
  id: "chat-1",
  title: "Chat",
  provider: "ollama",
  model: "m",
  system_prompt: null,
  params_json: null,
  space_id: null,
  pinned_at: null,
  archived_at: null,
  forked_from_session_id: null,
  label: null,
  folder_id: null,
  workspace_root: null,
  retrieval_mode: null,
  created_at: 0,
  updated_at: 0,
} as Session;

describe("full-text sources and the template pass", () => {
  it("leave placeholders inside a source as they are, and keep the date line", async () => {
    useSettingsStore.setState({
      global_system_prompt: "Call me {{USER_NAME}}.",
      user_name: "Ada",
      global_memory_enabled: false,
      temporal_awareness: true,
    });
    useLibraryStore.setState({
      hydrated: true,
      items: [item],
      datasets: [],
      sources: {
        "session:chat-1": [
          { id: "l1", owner_id: "chat-1", item_id: "tpl", dataset_id: null, enabled: true, position: 0, created_at: 0 },
        ],
      },
    });

    const { request } = await __testing.buildTaskRequest(chat, chat.id, [], "Draft it", []);
    const prompt = request.system_prompt ?? "";

    // The instructions are still templated…
    expect(prompt).toContain("Call me Ada.");
    expect(prompt).toMatch(/^Current date: /);
    // …the source is not, and comes after them.
    expect(prompt).toContain(BODY);
    expect(prompt.indexOf("Call me Ada.")).toBeLessThan(prompt.indexOf(BODY));
  });
});
