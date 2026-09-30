// `/set <param> <value>` accepts only what the Parameter panel can show, and
// `/set reset` drops the chat's override like the panel's Reset button.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";

const updateSessionParams = vi.hoisted(() =>
  vi.fn(async (_args: { id: string; params_json: string | null }) => {}),
);

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, updateSessionParams };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

function openChat(params_json: string | null) {
  useChatStore.setState({
    sessions: [{ id: "chat-1", space_id: null, params_json } as Session],
    activeSessionId: "chat-1",
  });
}

function storedParams(): string | null {
  return useChatStore.getState().sessions[0]!.params_json;
}

describe("/set", () => {
  beforeEach(() => {
    updateSessionParams.mockClear();
  });

  it("merges one value into the chat's existing overrides", async () => {
    openChat(JSON.stringify({ top_k: 20 }));
    const outcome = await dispatch("/set temperature 0.3", deps);
    expect(outcome).toMatchObject({
      result: { kind: "toast", title: "Set temperature", body: "0.3" },
    });
    expect(JSON.parse(storedParams()!)).toEqual({ top_k: 20, temperature: 0.3 });
  });

  it("accepts a context length the panel's slider can show", async () => {
    openChat(null);
    await dispatch("/set num_ctx 16384", deps);
    expect(JSON.parse(storedParams()!)).toEqual({ num_ctx: 16384 });
  });

  it.each([
    ["above the panel's cap", "/set temperature 1.5"],
    ["a non-decimal number", "/set top_k 0x10"],
    ["a fraction for a whole-number param", "/set max_tokens 512.5"],
    ["a context length between the stops", "/set num_ctx 10000"],
    ["a missing value", "/set seed"],
    ["an unknown param", "/set warmth 3"],
    ["an Object.prototype key", "/set constructor 1"],
  ])("rejects %s", async (_label, input) => {
    openChat(null);
    const outcome = await dispatch(input, deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(updateSessionParams).not.toHaveBeenCalled();
    expect(storedParams()).toBeNull();
  });

  it("reset clears the override", async () => {
    openChat(JSON.stringify({ temperature: 0.3, seed: 42 }));
    const outcome = await dispatch("/set reset", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Reset parameters" } });
    expect(updateSessionParams).toHaveBeenCalledWith({ id: "chat-1", params_json: null });
    expect(storedParams()).toBeNull();
  });
});
