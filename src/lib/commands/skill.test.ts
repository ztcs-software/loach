// `/skill` lists enabled skills; `/skill <name>` switches one on in the chat
// the composer belongs to, matching an exact name first, then a unique
// substring. Disabled skills are never matched, and nothing runs while
// skills are off.

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Session, SkillCatalog } from "@/types";

const catalog: SkillCatalog = {
  skills: [
    { name: "pdf", description: "Work with PDFs", path: "/s/pdf", source: "loach", enabled: true, warnings: [] },
    { name: "pdf-forms", description: "Fill PDF forms", path: "/s/pdf-forms", source: "agents", enabled: true, warnings: [] },
    { name: "docx", description: "Word files", path: "/s/docx", source: "loach", enabled: false, warnings: [] },
  ],
  problems: [],
};
const active: string[] = [];
const listSkills = vi.hoisted(() => vi.fn());
const sessionSkills = vi.hoisted(() => vi.fn());
const setSessionSkill = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, listSkills, sessionSkills, setSessionSkill };
});

import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";

const deps = { confirm: async () => true };

describe("/skill", () => {
  beforeEach(() => {
    active.length = 0;
    listSkills.mockReset().mockResolvedValue(catalog);
    sessionSkills.mockReset().mockImplementation(async () => [...active]);
    setSessionSkill.mockReset().mockImplementation(async (_sid: string, name: string) => {
      active.push(name);
    });
    useSettingsStore.setState({ skills_enabled: true });
    useSpaceStore.setState({ viewingSpaceId: null });
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null } as Session],
      activeSessionId: "chat-1",
    });
  });

  it("loads an exact name even when it is part of another", async () => {
    const outcome = await dispatch("/skill pdf", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Skill loaded" } });
    expect(setSessionSkill).toHaveBeenCalledWith("chat-1", "pdf", true);
  });

  it("loads a unique partial match, and lists an ambiguous one", async () => {
    await dispatch("/skill forms", deps);
    expect(setSessionSkill).toHaveBeenCalledWith("chat-1", "pdf-forms", true);
    setSessionSkill.mockClear();
    const outcome = await dispatch("/skill pd", deps);
    expect(outcome).toMatchObject({ result: { kind: "list" } });
    expect(setSessionSkill).not.toHaveBeenCalled();
  });

  it("never matches a disabled skill", async () => {
    const outcome = await dispatch("/skill docx", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(setSessionSkill).not.toHaveBeenCalled();
  });

  it("lists enabled skills and marks the loaded ones", async () => {
    active.push("pdf-forms");
    const outcome = await dispatch("/skill", deps);
    expect(outcome).toMatchObject({
      result: {
        kind: "list",
        items: [
          { label: "pdf", detail: undefined },
          { label: "pdf-forms", detail: "loaded" },
        ],
      },
    });
  });

  it("refuses while skills are off", async () => {
    useSettingsStore.setState({ skills_enabled: false });
    const outcome = await dispatch("/skill pdf", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(listSkills).not.toHaveBeenCalled();
  });
});
