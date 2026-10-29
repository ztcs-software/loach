// A model's Modelfile defaults and capabilities, when `/api/show` fails.
//
// The failure — Ollama simply not running yet — was cached as "no defaults,
// no capabilities" for the rest of the run: after starting Ollama the
// parameter panel still said the model couldn't think, and sends dropped the
// Modelfile's num_ctx.

import { describe, it, expect, vi } from "vitest";
import type { OllamaShowResponse } from "@/types";

const show = vi.hoisted(() => ({ fail: true }));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    ollamaShowModel: vi.fn(async (): Promise<OllamaShowResponse> => {
      if (show.fail) throw new Error("error sending request: connection refused");
      return {
        modelfile: null,
        parameters: "num_ctx 32768",
        template: null,
        system: null,
        license: null,
        details: null,
        model_info: null,
        capabilities: ["completion", "thinking"],
      };
    }),
  };
});

import { useModelsStore } from "./modelsStore";

describe("loadModelDefaults", () => {
  it("doesn't cache a failed show, so the model's real values load once Ollama is up", async () => {
    const store = () => useModelsStore.getState();
    expect(await store().loadModelDefaults("qwen3:8b")).toEqual({});
    expect(store().modelDefaults).not.toHaveProperty("qwen3:8b");
    expect(store().modelCapabilities).not.toHaveProperty("qwen3:8b");

    show.fail = false;
    expect(await store().loadModelDefaults("qwen3:8b")).toEqual({ num_ctx: 32768 });
    expect(store().modelCapabilities["qwen3:8b"]).toContain("thinking");
  });
});
