// `/space <name>` opens that Space's page, wherever it's typed.
//
//   - On a Space's page, changing only the active Space left the old page on
//     screen, while the next message started its chat in the new Space with
//     the old page's Library picks.
//   - From a chat, it set a hidden active Space that the memory commands and
//     `/new` then used (D1-01): `/remember` in a chat with no Space saved the
//     fact to that Space.

import { beforeEach, describe, it, expect } from "vitest";
import type { Session, Space } from "@/types";
import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";

const deps = { confirm: async () => true };

describe("/space", () => {
  beforeEach(() => {
    useSpaceStore.setState({
      spaces: [
        { id: "space-1", name: "Work" } as Space,
        { id: "space-2", name: "Home" } as Space,
      ],
    });
  });

  it("switches the Space being viewed on a Space's page", async () => {
    useSpaceStore.setState({ viewingSpaceId: "space-1", activeSpaceId: "space-1" });
    const outcome = await dispatch("/space Home", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", title: "Active Space", body: "Home" } });
    expect(useSpaceStore.getState()).toMatchObject({
      viewingSpaceId: "space-2",
      activeSpaceId: "space-2",
    });
  });

  it("opens the Space's page from a chat too", async () => {
    useSpaceStore.setState({ viewingSpaceId: null, activeSpaceId: null });
    await dispatch("/space Home", deps);
    expect(useSpaceStore.getState()).toMatchObject({ viewingSpaceId: "space-2", activeSpaceId: "space-2" });
    expect(useUIStore.getState().sidebarTab).toBe("spaces");
  });
});

describe("the memory commands in a chat with no Space", () => {
  it("act on the global list, whatever Space was active before", async () => {
    useSpaceStore.setState({ viewingSpaceId: null, activeSpaceId: "space-1" });
    useChatStore.setState({ sessions: [{ id: "c1", space_id: null } as Session], activeSessionId: "c1" });
    useSettingsStore.setState({ global_memory_enabled: false });
    const outcome = await dispatch("/remember I use a Mac", deps);
    expect(outcome).toMatchObject({ result: { kind: "toast", tone: "error" } });
    expect(JSON.stringify(outcome)).toMatch(/Global memory is off/);
  });
});
