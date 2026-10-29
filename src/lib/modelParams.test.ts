// `parseModelParameters` turns a Modelfile's PARAMETER block into the
// defaults every request from that model's chats carries — so a value the
// backend's `GenerationParams` can't hold fails each of those sends at the
// IPC boundary.

import { describe, it, expect } from "vitest";
import { parseModelParameters } from "./modelParams";

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
