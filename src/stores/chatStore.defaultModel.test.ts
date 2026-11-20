// Which model a new chat starts on, and under what name (X5-01–X5-03).
//
//   - "Use last <provider> model" took the model of the most recent chat on
//     that provider even after the model was deleted, so every new chat
//     opened on a tag that 404s.
//   - "Use most recent" followed header switches only: a chat started on a
//     model picked from the Models page (or a snippet) didn't count.
//   - Ollama models were stored as typed, so `x` and `x:latest` split the
//     per-model Thinking pref and the Modelfile caches between them.

import { describe, it, expect, beforeEach } from "vitest";
import type { ModelInfo, Session, Space } from "@/types";
import { installedIn, resolveDefaultModelChoice, useChatStore } from "./chatStore";
import { useModelsStore } from "./modelsStore";
import { useSettingsStore } from "./settingsStore";
import { useSpaceStore } from "./spaceStore";

const chat = (provider: string, model: string, updated_at: number) =>
  ({ id: `${provider}/${model}`, provider, model, updated_at }) as Session;
const listed = (provider: string, id: string) => ({ id, label: id, provider }) as ModelInfo;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("a provider pin (\"Use last Ollama model\")", () => {
  const sessions = [chat("ollama", "gone:8b", 3), chat("openai", "gpt-4o", 2), chat("ollama", "llama3.2", 1)];

  it("passes over a chat whose model was deleted", () => {
    const isInstalled = installedIn([listed("ollama", "llama3.2:latest"), listed("openai", "gpt-4o")]);
    expect(resolveDefaultModelChoice("provider:ollama", "ollama", "", sessions, isInstalled)).toEqual({
      provider: "ollama",
      model: "llama3.2",
    });
  });

  it("trusts chat history while the provider lists nothing", () => {
    const isInstalled = installedIn([listed("openai", "gpt-4o")]);
    expect(resolveDefaultModelChoice("provider:ollama", "ollama", "", sessions, isInstalled).model).toBe("gone:8b");
  });

  it("falls back to the recent pair when no chat's model is left", () => {
    const isInstalled = installedIn([listed("ollama", "qwen3:4b")]);
    expect(resolveDefaultModelChoice("provider:ollama", "ollama", "qwen3:4b", sessions, isInstalled)).toEqual({
      provider: "ollama",
      model: "qwen3:4b",
    });
  });
});

describe("starting and switching chats", () => {
  beforeEach(() => {
    useSettingsStore.setState({ default_model_choice: "recent", default_provider: "ollama", default_model: "old:1b" });
    useSpaceStore.setState({ spaces: [], activeSpaceId: null });
    useModelsStore.setState({ models: [], modelDefaults: {}, modelCapabilities: {} });
    useChatStore.setState({ sessions: [], activeSessionId: null, messages: {} });
  });
  const pair = () => [useSettingsStore.getState().default_provider, useSettingsStore.getState().default_model];

  it("records a model picked for a new chat as the most recent, with its tag", async () => {
    const s = await useChatStore.getState().newSession({ provider: "ollama", model: "qwen3" });
    await tick();
    expect(s.model).toBe("qwen3:latest");
    expect(pair()).toEqual(["ollama", "qwen3:latest"]);
  });

  it("keeps a Space's pinned model out of the most recent pair", async () => {
    useSpaceStore.setState({
      spaces: [{ id: "sp", default_provider: "ollama", default_model: "space-model:2b" } as Space],
    });
    const s = await useChatStore.getState().newSession({ spaceId: "sp" });
    await tick();
    expect(s.model).toBe("space-model:2b");
    expect(pair()).toEqual(["ollama", "old:1b"]);
  });

  it("stores a header switch to an Ollama model with its tag", async () => {
    const s = await useChatStore.getState().newSession();
    await useChatStore.getState().setSessionModel(s.id, "ollama", "llama3.2");
    await tick();
    expect(useChatStore.getState().sessions.find((x) => x.id === s.id)?.model).toBe("llama3.2:latest");
    expect(pair()).toEqual(["ollama", "llama3.2:latest"]);
  });
});
