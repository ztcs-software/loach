// `/space <name>` typed on a Space's page goes to that Space's page. Changing
// only the active Space left the old page on screen, while the next message
// started its chat in the new Space with the old page's Library picks.

import { beforeEach, describe, it, expect } from "vitest";
import type { Space } from "@/types";
import { dispatch } from "./dispatch";
import { useSpaceStore } from "@/stores/spaceStore";

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

  it("only changes the active Space elsewhere", async () => {
    useSpaceStore.setState({ viewingSpaceId: null, activeSpaceId: "space-1" });
    await dispatch("/space Home", deps);
    expect(useSpaceStore.getState()).toMatchObject({
      viewingSpaceId: null,
      activeSpaceId: "space-2",
    });
  });
});
