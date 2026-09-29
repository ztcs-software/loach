// Private Chat sends the parameters its panel shows.
//
// It used to send only what the user had changed (plus the Low VRAM pin),
// leaving everything else to Ollama's own defaults, while the panel showed
// the merged values — an 8K context, the global Thinking default, the
// model's Modelfile defaults — that the request never carried.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ChatRequest } from "@/types";

const startChatStream = vi.hoisted(() =>
  vi.fn((request: { stream_id: string }) =>
    Promise.resolve({
      streamId: request.stream_id,
      stop: () => Promise.resolve(),
      unlisten: () => undefined,
    }),
  ),
);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, startChatStream };
});

import { usePrivateChatStore } from "./privateChatStore";
import { useModelsStore } from "./modelsStore";
import { useSettingsStore } from "./settingsStore";

async function sentParams(): Promise<ChatRequest["params"]> {
  await usePrivateChatStore.getState().send("hi", []);
  const request = startChatStream.mock.calls.at(-1)![0] as ChatRequest;
  return request.params;
}

describe("Private Chat request params", () => {
  beforeEach(() => {
    startChatStream.mockClear();
    usePrivateChatStore.getState().wipe();
    usePrivateChatStore.setState({ model: "m" });
    useModelsStore.setState({ modelDefaults: {} });
    useSettingsStore.setState({ thinking_default: false, low_vram_global: false });
  });

  it("sends the app defaults and the global Thinking default when nothing was changed", async () => {
    const params = await sentParams();
    expect(params.num_ctx).toBe(8192);
    expect(params.temperature).toBe(0.7);
    expect(params.think).toBe(false);
  });

  it("layers Modelfile defaults under the panel's overrides", async () => {
    useModelsStore.setState({ modelDefaults: { m: { num_ctx: 4096, temperature: 0.2 } } });
    usePrivateChatStore.getState().setParams({ num_ctx: 16384 });
    const params = await sentParams();
    expect(params.num_ctx).toBe(16384);
    expect(params.temperature).toBe(0.2);
  });

  it("applies the global Low VRAM pin", async () => {
    useSettingsStore.setState({ low_vram_global: true });
    expect((await sentParams()).low_vram).toBe(true);
  });
});
