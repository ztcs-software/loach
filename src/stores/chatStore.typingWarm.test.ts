// Typing into a chat's composer starts loading its Ollama model
// (`warmModelForTyping`):
//
//   - sized with the runner options the send will carry, so the send doesn't
//     reload it — and once per stretch of typing, not per keystroke, also
//     when the model's Modelfile can't be read;
//   - never while a reply streams, nor for an OpenAI-compatible chat.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@/types";

const mocks = vi.hoisted(() => ({
  preload: vi.fn<typeof import("@/lib/tauri").ollamaPreloadModel>(() => Promise.resolve()),
  show: vi.fn<typeof import("@/lib/tauri").ollamaShowModel>(() =>
    Promise.reject(new Error("connection refused")),
  ),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, ollamaPreloadModel: mocks.preload, ollamaShowModel: mocks.show };
});

import { useChatStore, warmModelForTyping, __testing } from "./chatStore";
import { useModelsStore } from "./modelsStore";
import { useSettingsStore } from "./settingsStore";

const chat = (fields: Partial<Session>) =>
  ({
    id: "c1",
    provider: "ollama",
    model: "test-model",
    params_json: JSON.stringify({ num_gpu: 20 }),
    space_id: null,
    ...fields,
  }) as Session;

describe("warmModelForTyping", () => {
  beforeEach(() => {
    mocks.preload.mockClear();
    mocks.show.mockClear();
    __testing.resetForTests();
    useSettingsStore.setState({ ollama_base_url: "http://localhost:11434" });
    useModelsStore.setState({ modelDefaults: { "test-model": { num_ctx: 32768 } } });
    useChatStore.setState({ sessions: [chat({})], isStreaming: false });
  });

  it("loads the model the way the send will, once across keystrokes", async () => {
    await warmModelForTyping("c1");
    await warmModelForTyping("c1");
    expect(mocks.preload).toHaveBeenCalledTimes(1);
    expect(mocks.preload).toHaveBeenCalledWith("http://localhost:11434", "test-model", 32768, 20);
  });

  it("loads it again once the chat's runner options change", async () => {
    await warmModelForTyping("c1");
    useChatStore.setState({ sessions: [chat({ params_json: JSON.stringify({ num_ctx: 4096 }) })] });
    await warmModelForTyping("c1");
    expect(mocks.preload).toHaveBeenCalledTimes(2);
    expect(mocks.preload).toHaveBeenLastCalledWith(
      "http://localhost:11434",
      "test-model",
      4096,
      undefined,
    );
  });

  // That read caches nothing when it fails (Ollama down, the model removed):
  // throttled only after it, every keystroke sent another `/api/show`.
  it("asks for an unreadable Modelfile once across keystrokes", async () => {
    useModelsStore.setState({ modelDefaults: {} });
    await warmModelForTyping("c1");
    await warmModelForTyping("c1");
    await warmModelForTyping("c1");
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.preload).toHaveBeenCalledTimes(1);
  });

  it("does nothing while a reply streams", async () => {
    useChatStore.setState({ isStreaming: true });
    await warmModelForTyping("c1");
    expect(mocks.preload).not.toHaveBeenCalled();
  });

  it("does nothing for an OpenAI-compatible chat", async () => {
    useChatStore.setState({ sessions: [chat({ provider: "openai", model: "gpt-4o" })] });
    await warmModelForTyping("c1");
    expect(mocks.preload).not.toHaveBeenCalled();
  });
});
