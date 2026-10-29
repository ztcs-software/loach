// Coverage for the two checks behind Private Chat's "nothing leaves this
// machine" promise: which Ollama tags its picker hides because Ollama runs
// them on ollama.com, and which base URLs let the empty state say "local".

import { describe, it, expect } from "vitest";
import { __testing } from "./PrivateChat";

const { isCloudModel, isLoopbackUrl } = __testing;

describe("isCloudModel", () => {
  it("catches both spellings of a cloud tag", () => {
    expect(isCloudModel("gpt-oss:120b-cloud")).toBe(true);
    expect(isCloudModel("glm-4.6:cloud")).toBe(true);
    expect(isCloudModel("Qwen3-Coder:480B-Cloud")).toBe(true);
  });

  it("leaves installed models alone", () => {
    expect(isCloudModel("llama3.2:latest")).toBe(false);
    expect(isCloudModel("qwen3:8b")).toBe(false);
    // "cloud" in the model's name, not its tag.
    expect(isCloudModel("cloud-helper:latest")).toBe(false);
    expect(isCloudModel("soundcloud:7b")).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it("accepts this machine however it's spelled", () => {
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://LOCALHOST:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.1.2.3:11434")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:11434")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:11434")).toBe(true);
  });

  it("rejects other hosts and garbage", () => {
    expect(isLoopbackUrl("http://192.168.1.10:11434")).toBe(false);
    expect(isLoopbackUrl("https://ollama.example.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.example.com:11434")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
