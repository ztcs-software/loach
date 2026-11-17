// `parseModelParameters` turns a Modelfile's PARAMETER block into the
// defaults every request from that model's chats carries — so a value the
// backend's `GenerationParams` can't hold fails each of those sends at the
// IPC boundary.

import { describe, it, expect } from "vitest";
import { defaultNumCtx, modelContextLength, parseModelParameters } from "./modelParams";

describe("parseModelParameters", () => {
  it("maps the keys it knows and drops the rest", () => {
    expect(
      parseModelParameters('temperature 0.6\nnum_predict 512\nnum_ctx 8192\nstop "<|im_end|>"\nseed 42'),
    ).toEqual({ temperature: 0.6, max_tokens: 512, num_ctx: 8192, seed: 42 });
  });

  it("leaves out sentinels the backend's unsigned fields can't hold", () => {
    // Regression: `num_predict -1` ("no limit") reached `max_tokens:
    // Option<u32>`, the request failed to deserialize, and every send in the
    // model's chats failed with it.
    expect(
      parseModelParameters("num_predict -1\nnum_gpu -1\ntop_k -1\nnum_ctx 4096.5\ntemperature 0.7"),
    ).toEqual({ temperature: 0.7 });
    expect(parseModelParameters("num_ctx 99999999999")).toEqual({});
    expect(parseModelParameters("seed 99999999999999999999")).toEqual({});
  });

  it("keeps values that only look unusual", () => {
    expect(parseModelParameters("num_gpu 0\ntop_k 0\nseed -1")).toEqual({ num_gpu: 0, top_k: 0, seed: -1 });
  });
});

// Settings' default context length is the window a chat gets when nothing
// above it sets one — capped at the model's maximum, or the context bar
// promises a window the model doesn't have.
describe("defaultNumCtx", () => {
  it("uses the setting, capped at the model's maximum when known", () => {
    expect(defaultNumCtx(32768)).toBe(32768);
    expect(defaultNumCtx(32768, 131072)).toBe(32768);
    expect(defaultNumCtx(65536, 8192)).toBe(8192);
    expect(defaultNumCtx(65536, 0)).toBe(65536);
  });

  it("falls back to 8192 for a setting that isn't a window", () => {
    // `Number()` of a bad settings row, or one a backup carried in.
    for (const bad of [NaN, 0, -1, 4096.5, 2 ** 32, "32768", undefined]) {
      expect(defaultNumCtx(bad)).toBe(8192);
    }
  });
});

describe("modelContextLength", () => {
  it("reads the architecture's context_length from model_info", () => {
    const info = {
      "general.architecture": "gemma4",
      "gemma4.context_length": 131072,
      "gemma4.embedding_length": 2560,
    };
    expect(modelContextLength(info)).toBe(131072);
  });

  it("is undefined when model_info doesn't say", () => {
    expect(modelContextLength(null)).toBeUndefined();
    expect(modelContextLength({ "llama.context_length": 8192 })).toBeUndefined();
    expect(modelContextLength({ "general.architecture": "llama", "llama.context_length": "8192" })).toBeUndefined();
  });
});
