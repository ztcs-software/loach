// A Space's page opens on the tab a link asks for, else the one it was last
// left on.
//
// The tab used to be local component state, so every visit started on Chats:
// the composer's "Space sources" chip landed there instead of on Sources, and
// coming back from one of the Space's chats lost the tab the user was on.

import { beforeEach, describe, expect, it } from "vitest";
import { useSpaceStore } from "./spaceStore";

const get = () => useSpaceStore.getState();

beforeEach(() => {
  useSpaceStore.setState({ viewingSpaceId: null, activeSpaceId: null, spaceTabs: {} });
});

describe("Space page tabs", () => {
  it("opens on the requested tab and remembers it per Space", () => {
    get().setViewingSpace("a", "files");
    expect(get().spaceTabs.a).toBe("files");

    // Away and back without asking for a tab: still Sources.
    get().setViewingSpace(null);
    get().setViewingSpace("a");
    expect(get().spaceTabs.a).toBe("files");

    // Another Space keeps its own — none yet, so the page shows Chats.
    get().setViewingSpace("b");
    expect(get().spaceTabs.b).toBeUndefined();
  });

  it("records a tab the user picks on the page", () => {
    get().setViewingSpace("a");
    get().setSpaceTab("a", "memory");
    get().setViewingSpace(null);
    get().setViewingSpace("a");
    expect(get().spaceTabs.a).toBe("memory");
  });
});
