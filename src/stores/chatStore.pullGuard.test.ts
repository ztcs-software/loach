// Coverage for the guard that refuses a send while the session's model is
// still downloading.
//
// The guard exists because onboarding pins a model at pull *start* and lets the
// user carry on, so their first message can land before the tag exists; Ollama
// answers 404 and the UI renders "endpoint or model not found. Check the model
// name and URL", which sends a brand-new user off to debug a correct URL.
//
// It has to be narrow, though. A run's `target` is only a string, so matching
// on it alone also blocked two cases where the model answers perfectly well:
// re-pulling an already-installed tag (the normal way to update one — Ollama
// serves the resident copy until the new manifest lands), and an OpenAI-
// compatible session whose model id happens to equal a tag being pulled.

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, __testing } from "./chatStore";
import { useModelsStore, type AdminProgress } from "./modelsStore";
import type { ModelInfo, Session } from "@/types";

const session = (over: Partial<Session>): Session =>
  ({
    id: "sess-A",
    title: "A",
    provider: "ollama",
    model: "llama3:8b",
    system_prompt: null,
    params_json: null,
    space_id: null,
    pinned_at: null,
    archived_at: null,
    forked_from_session_id: null,
    label: null,
    folder_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  }) as Session;

const livePull = (target: string): AdminProgress =>
  ({
    kind: "pull",
    target,
    status: "downloading",
    total: 100,
    completed: 42,
    finished: null,
    error: null,
  }) as AdminProgress;

const installed = (id: string): ModelInfo => ({
  id,
  label: id,
  provider: "ollama",
});

function setup(over: Partial<Session>, models: ModelInfo[] = []) {
  __testing.resetForTests();
  useModelsStore.setState({
    runs: { "run-1": livePull("llama3:8b") },
    models,
  } as never);
  useChatStore.setState({
    sessions: [session(over)],
    activeSessionId: "sess-A",
    messages: { "sess-A": [] },
    runningTask: null,
    queue: [],
  } as never);
}

/** Whatever the send ends up doing past the guard (there's no Tauri backend
 *  under vitest), all these cases care about is whether it was the guard that
 *  stopped it. */
const sendError = () =>
  useChatStore
    .getState()
    .sendUserMessage("hi", [])
    .then(
      () => "",
      (e: unknown) => String(e),
    );

describe("sendUserMessage model-download guard", () => {
  beforeEach(() => {
    useModelsStore.setState({ runs: {}, models: [] } as never);
  });

  it("blocks the send while the pinned tag is downloading for the first time", async () => {
    setup({});
    await expect(useChatStore.getState().sendUserMessage("hi", [])).rejects.toThrow(
      /still downloading \(42%\)/,
    );
  });

  it("allows the send when the tag is already installed (a re-pull to update)", async () => {
    setup({}, [installed("llama3:8b")]);
    expect(await sendError()).not.toMatch(/still downloading/);
  });

  it("allows the send for a non-Ollama session whose model id collides", async () => {
    setup({ provider: "openai", model: "llama3:8b" });
    expect(await sendError()).not.toMatch(/still downloading/);
  });
});
