// `/settings <tab>` knows every Settings tab. Its list was written out by hand
// and missed "library", so `/settings library` refused a real tab.

import { describe, it, expect } from "vitest";
import { dispatch } from "./dispatch";
import { useUIStore } from "@/stores/uiStore";

const deps = { confirm: async () => true };

describe("/settings", () => {
  it("opens the Library tab", async () => {
    useUIStore.setState({ settingsOpen: false, settingsTab: "general" });
    expect(await dispatch("/settings library", deps)).toMatchObject({ result: { kind: "noop" } });
    expect(useUIStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: "library" });
  });

  it("refuses an unknown tab", async () => {
    expect(await dispatch("/settings bogus", deps)).toMatchObject({
      result: { kind: "toast", tone: "error" },
    });
  });
});
