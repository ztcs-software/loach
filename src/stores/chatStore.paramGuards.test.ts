// Stored parameter overrides the backend can't deserialize (F1-02).
//
// The backend reads `top_k`, `max_tokens`, `num_ctx` and `num_gpu` as `u32`
// and `seed` as `i64`. The guards on a chat's `params_json` (and a Space's
// `default_params_json`) only checked for a finite number, so `4096.5` or
// `-1` from an import or a hand edit reached `chat_stream`, failed its
// deserialization, and every send in the chat ended in an error. An invalid
// `seed` was also copied as `undefined`, spreading over a valid Space seed.

import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PARAMS, OPENAI_COMPAT_NUM_CTX, type Session } from "@/types";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getSpaceContext: vi.fn(async () => ({ space: SPACE, files: [], memories: [] })),
  };
});

import { __testing, layerParams, parseOverrides } from "./chatStore";
import { useSettingsStore } from "./settingsStore";
import { useSpaceStore } from "./spaceStore";

const SPACE = {
  id: "space-1",
  name: "Space",
  description: "",
  instructions: "",
  default_provider: null,
  default_model: null,
  default_params_json: JSON.stringify({ seed: 7 }),
  memory_enabled: false,
  created_at: 0,
  updated_at: 0,
};

function chat(params: Record<string, unknown>, spaceId: string | null = null): Session {
  return {
    id: "chat-1",
    title: "Chat",
    provider: "openai",
    model: "m",
    system_prompt: null,
    params_json: JSON.stringify(params),
    space_id: spaceId,
    pinned_at: null,
    archived_at: null,
    forked_from_session_id: null,
    label: null,
    folder_id: null,
    workspace_root: null,
    created_at: 0,
    updated_at: 0,
  } as Session;
}

async function paramsFor(session: Session) {
  useSettingsStore.setState({ global_memory_enabled: false, temporal_awareness: false });
  useSpaceStore.setState({ spaces: [SPACE] } as never);
  const { request } = await __testing.buildTaskRequest(session, session.id, [], "hi", []);
  return request.params;
}

describe("stored parameter overrides", () => {
  it("drop values the backend's integer fields can't hold", async () => {
    const params = await paramsFor(
      chat({ num_ctx: 4096.5, top_k: -1, max_tokens: -1, num_gpu: 2 ** 32, seed: 1.5, temperature: 0.3 }),
    );
    expect(params.num_ctx).toBe(OPENAI_COMPAT_NUM_CTX);
    expect(params.top_k).toBe(DEFAULT_PARAMS.top_k);
    expect(params.max_tokens).toBe(DEFAULT_PARAMS.max_tokens);
    expect(params.num_gpu).toBe(DEFAULT_PARAMS.num_gpu);
    expect(params.seed).toBe(DEFAULT_PARAMS.seed);
    expect(params.temperature).toBe(0.3);
  });

  it("keep valid ones, and `seed: null`", async () => {
    const params = await paramsFor(chat({ num_ctx: 8192, top_k: 20, max_tokens: 0, seed: null }));
    expect(params).toMatchObject({ num_ctx: 8192, top_k: 20, max_tokens: 0, seed: null });
  });

  it("let an invalid chat seed fall through to the Space's", async () => {
    expect((await paramsFor(chat({ seed: 1.5 }, "space-1"))).seed).toBe(7);
  });
});

// F7-01 / F7-03: the Parameters panel had its own merge and parse. It now
// uses these, so it shows (and saves) what a send uses.
describe("the panel's merge", () => {
  const base = { modelDefaults: undefined, thinkingDefault: true, thinkPref: undefined, spaceLayer: {}, overrides: {} };
  it("gives an OpenAI chat the window a send assumes, not the app's 8K", async () => {
    expect(layerParams({ ...base, provider: "openai" }).num_ctx).toBe(OPENAI_COMPAT_NUM_CTX);
    expect((await paramsFor(chat({}))).num_ctx).toBe(OPENAI_COMPAT_NUM_CTX);
  });
  it("drops wrong-typed stored values instead of handing them to a slider", () => {
    expect(parseOverrides(JSON.stringify({ temperature: "0.7", top_k: 20 }))).toEqual({ top_k: 20 });
    expect(parseOverrides("null")).toEqual({});
  });
});
