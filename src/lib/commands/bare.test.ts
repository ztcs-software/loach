// Bare `/model`, `/persona` and `/tone`: the first opens the model picker,
// the other two report what the chat currently uses instead of failing with
// a usage error.

import { beforeEach, describe, it, expect } from "vitest";
import type { Session } from "@/types";
import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUIStore } from "@/stores/uiStore";

const deps = { confirm: async () => true };

describe("bare invocations", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null } as Session],
      activeSessionId: "chat-1",
    });
    useUIStore.setState({
      pendingOpenModelPicker: false,
      personaIdBySession: {},
      toneIdBySession: {},
    });
    useSettingsStore.setState({ default_tone_id: "default" });
  });

  it("/model opens the model picker", async () => {
    expect(await dispatch("/model", deps)).toMatchObject({ result: { kind: "noop" } });
    expect(useUIStore.getState().pendingOpenModelPicker).toBe(true);
  });

  it("/persona reports the chat's persona", async () => {
    expect(await dispatch("/persona", deps)).toMatchObject({
      result: { kind: "toast", title: "No persona set" },
    });
    useUIStore.getState().setSessionPersona("chat-1", "code-reviewer");
    expect(await dispatch("/persona", deps)).toMatchObject({
      result: { kind: "toast", title: "Current persona", body: "Code Reviewer" },
    });
  });

  it("/tone reports the effective tone and where it comes from", async () => {
    expect(await dispatch("/tone", deps)).toMatchObject({
      result: { kind: "toast", title: "No tone set" },
    });
    useSettingsStore.setState({ default_tone_id: "casual" });
    expect(await dispatch("/tone", deps)).toMatchObject({
      result: { kind: "toast", title: "Current tone", body: "Casual (app default)" },
    });
    useUIStore.getState().setSessionTone("chat-1", "direct");
    expect(await dispatch("/tone", deps)).toMatchObject({
      result: { kind: "toast", title: "Current tone", body: "Direct" },
    });
    // An explicit Default for this chat overrides the app-wide tone.
    useUIStore.getState().setSessionTone("chat-1", "default");
    expect(await dispatch("/tone", deps)).toMatchObject({
      result: { kind: "toast", title: "No tone set" },
    });
  });
});
