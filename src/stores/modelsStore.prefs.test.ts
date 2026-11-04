// Model defaults that outlive a model, and per-model settings that outlive
// a launch.
//
//   - Deleting a model left the Settings default and any Space's default
//     pinned to it, so every new chat there started on a tag Ollama no
//     longer had.
//   - The per-model Thinking toggle ("Default for new chats with this
//     model") lived in memory only and was gone on the next launch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Space } from "@/types";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    ollamaDeleteModel: vi.fn(async () => undefined),
    ollamaListModels: vi.fn(async () => []),
  };
});

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
});

const space = (id: string, provider: Space["default_provider"], model: string | null) =>
  ({
    id,
    name: id,
    description: "",
    instructions: "",
    default_provider: provider,
    default_model: model,
    default_params_json: null,
    memory_enabled: true,
    retrieval_mode: "auto",
    image_scaling_json: null,
    created_at: 0,
    updated_at: 0,
  }) satisfies Space;

beforeEach(() => {
  saved.clear();
  vi.resetModules();
});

describe("deleting a model", () => {
  it("unpins the global default and every Space default aimed at it", async () => {
    const { useModelsStore } = await import("./modelsStore");
    const { useSettingsStore } = await import("./settingsStore");
    const { useSpaceStore } = await import("./spaceStore");
    useSettingsStore.setState({
      default_model_choice: "model:ollama:llama3:8b",
      default_provider: "ollama",
      default_model: "llama3:8b",
    });
    useSpaceStore.setState({
      spaces: [space("pinned", "ollama", "llama3:8b"), space("remote", "openai", "llama3:8b"), space("other", "ollama", "qwen3:4b")],
    });

    await useModelsStore.getState().deleteModel("llama3:8b");

    const settings = useSettingsStore.getState();
    expect(settings.default_model_choice).toBe("recent");
    expect(settings.default_model).toBe("");
    expect(useSpaceStore.getState().spaces.map((s) => [s.default_provider, s.default_model])).toEqual([
      [null, null],
      ["openai", "llama3:8b"],
      ["ollama", "qwen3:4b"],
    ]);
  });
});

describe("the per-model Thinking default", () => {
  it("is still there on the next launch", async () => {
    const first = await import("./modelsStore");
    first.useModelsStore.getState().setModelThinkPref("qwen3:4b", false);
    first.useModelsStore.getState().setModelThinkPref("deepseek-r1", true);
    first.useModelsStore.getState().setModelThinkPref("deepseek-r1", null);

    vi.resetModules();
    const next = await import("./modelsStore");
    expect(next.useModelsStore.getState().modelThinkPrefs).toEqual({ "qwen3:4b": false });
  });
});
