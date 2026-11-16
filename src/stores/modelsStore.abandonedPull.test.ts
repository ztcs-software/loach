// A failed or cancelled pull that held the default model (F7-09).
//
// Onboarding pins every pull it starts. Pull a small model, then a bigger one
// (now the default), and stop the bigger one after the small one has landed:
// the default was cleared to nothing, though a model had downloaded fine.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelInfo } from "@/types";

const listed = vi.hoisted(() => ({ models: [] as ModelInfo[] }));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    ollamaListModels: vi.fn(async () => listed.models),
    // Fails at once, the way a dropped connection or a full disk ends a pull.
    ollamaPullModel: vi.fn(async (args: { stream_id: string }, onEvent: (ev: unknown) => void) => {
      onEvent({ kind: "error", message: "disk full" });
      return { streamId: args.stream_id, stop: async () => {}, unlisten: () => {} };
    }),
  };
});

import { useModelsStore, type AdminProgress } from "./modelsStore";
import { useSettingsStore } from "./settingsStore";

const pull = (target: string, finished: AdminProgress["finished"]): AdminProgress => ({
  kind: "pull",
  target,
  status: finished ?? "downloading",
  total: 0,
  completed: 0,
  finished,
  error: null,
});

beforeEach(() => {
  useSettingsStore.setState({ default_provider: "ollama", default_model: "qwen3.5:27b" });
});

describe("a pull that held the default and failed", () => {
  it("hands the default back to a model pulled before it", async () => {
    listed.models = [{ id: "qwen3.5:4b", label: "qwen3.5:4b", provider: "ollama" }];
    useModelsStore.setState({ runs: { first: pull("qwen3.5:4b", "ok") } });

    await useModelsStore.getState().pullModel("qwen3.5:27b");

    expect(useSettingsStore.getState().default_model).toBe("qwen3.5:4b");
  });

  it("or to one still downloading", async () => {
    listed.models = [];
    useModelsStore.setState({ runs: { first: pull("qwen3.5:4b", null) } });

    await useModelsStore.getState().pullModel("qwen3.5:27b");

    expect(useSettingsStore.getState().default_model).toBe("qwen3.5:4b");
  });

  it("clears it when no other pull has a model to offer", async () => {
    listed.models = [];
    useModelsStore.setState({ runs: { first: pull("qwen3.5:4b", "error") } });

    await useModelsStore.getState().pullModel("qwen3.5:27b");

    expect(useSettingsStore.getState().default_model).toBe("");
  });
});
