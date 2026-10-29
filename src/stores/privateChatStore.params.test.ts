// Private Chat sends the parameters its panel shows.
//
// It used to send only what the user had changed (plus the Low VRAM pin),
// leaving everything else to Ollama's own defaults, while the panel showed
// the merged values — an 8K context, the global Thinking default, the
// model's Modelfile defaults — that the request never carried.
//
// And it sends nothing anywhere else: the request is marked private (no MCP,
// no workspace) and offers no tools, and no other backend call — no message,
// session or setting written — happens on the way.

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
/** Every other `@/lib/tauri` call a send makes, by name. */
const otherIpc = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const recorded = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            otherIpc.push(name);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
  return { ...recorded, startChatStream, makeRequestId: actual.makeRequestId };
});

import { usePrivateChatStore } from "./privateChatStore";
import { useModelsStore } from "./modelsStore";
import { useSettingsStore } from "./settingsStore";

async function sentRequest(): Promise<ChatRequest> {
  await usePrivateChatStore.getState().send("hi", []);
  return startChatStream.mock.calls.at(-1)![0] as ChatRequest;
}

async function sentParams(): Promise<ChatRequest["params"]> {
  return (await sentRequest()).params;
}

describe("Private Chat request params", () => {
  beforeEach(() => {
    startChatStream.mockClear();
    otherIpc.length = 0;
    usePrivateChatStore.getState().wipe();
    usePrivateChatStore.setState({ model: "m" });
    useModelsStore.setState({ modelDefaults: {}, modelCapabilities: { m: ["thinking"] } });
    useSettingsStore.setState({ thinking_default: false, low_vram_global: false });
  });

  it("sends the app defaults and the global Thinking default when nothing was changed", async () => {
    const params = await sentParams();
    expect(params.num_ctx).toBe(8192);
    expect(params.temperature).toBe(0.7);
    expect(params.think).toBe(false);
  });

  // Ollama answers `think` on such a model with a 400, and the retry
  // without it cost a second request on every message.
  it("leaves `think` out for a model that can't think, or whose capabilities aren't known", async () => {
    useModelsStore.setState({ modelCapabilities: { m: ["completion"] } });
    expect(await sentParams()).not.toHaveProperty("think");
    usePrivateChatStore.setState({ isStreaming: false });
    useModelsStore.setState({ modelCapabilities: {} });
    expect(await sentParams()).not.toHaveProperty("think");
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

  it("is marked private, offers no tools and persists nothing", async () => {
    const request = await sentRequest();
    expect(request.private).toBe(true);
    expect(request.no_tools).toBe(true);
    expect(request.session_id).toBeUndefined();
    expect(otherIpc).toEqual([]);
  });
});
