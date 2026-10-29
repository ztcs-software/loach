// A chat reopened after a restart sends its model's Modelfile parameters.
//
// `readSessionParams` reads them from a cache that only `newSession`, a model
// switch and the parameter panel warmed. A chat opened from the sidebar in a
// new session therefore went out with DEFAULT_PARAMS — num_ctx 8192 over the
// Modelfile's 32768, temperature 0.7 over its own — until the parameter
// panel happened to be opened.

import { describe, it, expect, vi } from "vitest";
import { OPENAI_COMPAT_NUM_CTX, type OllamaShowResponse, type Session } from "@/types";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    libraryListSources: vi.fn(async () => []),
    ollamaShowModel: vi.fn(
      async (): Promise<OllamaShowResponse> => ({
        modelfile: null,
        parameters: "num_ctx 32768\ntemperature 0.2",
        template: null,
        system: null,
        license: null,
        details: null,
        model_info: null,
        capabilities: [],
      }),
    ),
  };
});

import { __testing } from "./chatStore";
import { useLibraryStore } from "./libraryStore";
import { useModelsStore } from "./modelsStore";

const chat = {
  id: "chat-1",
  title: "Chat",
  provider: "ollama",
  model: "custom:8b",
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

describe("a chat sent from with a cold model-defaults cache", () => {
  it("carries the Modelfile's parameters, not the app defaults", async () => {
    useModelsStore.setState({ modelDefaults: {}, modelCapabilities: {} });
    useLibraryStore.setState({ hydrated: true, items: [], datasets: [], sources: {} });

    const { request } = await __testing.buildTaskRequest(chat, chat.id, [], "hi", []);

    expect(request.params.num_ctx).toBe(32768);
    expect(request.params.temperature).toBe(0.2);
  });
});

describe("an OpenAI-compatible chat", () => {
  // Those servers ignore num_ctx and don't report their window, so it only
  // sizes sources — and 8192 pushed a 128k model's sources to excerpts.
  it("is sized against the assumed window, not the Ollama default", async () => {
    useLibraryStore.setState({ hydrated: true, items: [], datasets: [], sources: {} });
    const openai = { ...chat, id: "chat-2", provider: "openai", model: "gpt-4o" } as Session;

    const { request } = await __testing.buildTaskRequest(openai, openai.id, [], "hi", []);

    expect(request.params.num_ctx).toBe(OPENAI_COMPAT_NUM_CTX);
  });
});
