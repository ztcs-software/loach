// `/model <name>` when Ollama and an OpenAI-compatible server serve the same
// id: a provider prefix picks between them, where the bare id used to take
// whichever was listed first. And a switch that fails to save says nothing
// of its own — the store already toasted the error.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ModelInfo, Session } from "@/types";

const updateSessionModel = vi.hoisted(() =>
  vi.fn(async (_args: { id: string; provider: string; model: string }) => {}),
);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, updateSessionModel };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";

const deps = { confirm: async () => true };

// The store's failure toast arms a `window.setTimeout`.
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

const model =(provider: string, id: string): ModelInfo => ({ id, label: id, provider });

function chat(): Session {
  return useChatStore.getState().sessions[0]!;
}

describe("/model", () => {
  beforeEach(() => {
    updateSessionModel.mockReset();
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null, provider: "ollama", model: "qwen3:8b" } as Session],
      activeSessionId: "chat-1",
    });
    useModelsStore.setState({
      models: [
        model("ollama", "llama3"),
        model("ollama", "qwen3:8b"),
        model("openai", "llama3"),
        model("openai", "openai/gpt-4o"),
      ],
    });
  });

  it("lists an id two providers serve under both prefixes", async () => {
    const outcome = await dispatch("/model llama3", deps);
    expect(outcome).toMatchObject({
      result: {
        kind: "list",
        items: [
          { label: "ollama/llama3", detail: "ollama" },
          { label: "openai/llama3", detail: "openai" },
        ],
      },
    });
    expect(updateSessionModel).not.toHaveBeenCalled();
  });

  it("takes a provider prefix", async () => {
    const outcome = await dispatch("/model openai/llama3", deps);
    expect(outcome).toMatchObject({
      result: { kind: "toast", title: "Switched model", body: "llama3 (openai)" },
    });
    expect(chat()).toMatchObject({ provider: "openai", model: "llama3" });
  });

  it("matches an id with a slash of its own before reading a prefix", async () => {
    await dispatch("/model openai/gpt-4o", deps);
    expect(chat()).toMatchObject({ provider: "openai", model: "openai/gpt-4o" });
  });

  it("reports no switch when the save failed", async () => {
    updateSessionModel.mockRejectedValueOnce(new Error("disk full"));
    const outcome = await dispatch("/model openai/llama3", deps);
    expect(outcome).toMatchObject({ result: { kind: "noop" } });
    expect(chat()).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
  });
});
