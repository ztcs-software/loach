// A command that takes no argument refuses one rather than running and
// dropping it — `/regenerate but shorter` used to regenerate the same way and
// lose "but shorter" along with the composer text.

import { describe, it, expect, vi } from "vitest";
import type { Session } from "@/types";
import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

describe("arguments to a command that takes none", () => {
  it("are refused without running the command", async () => {
    const regenerateLast = vi.fn(async (_sessionId: string) => {});
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null } as Session],
      activeSessionId: "chat-1",
      regenerateLast,
    });
    const outcome = await dispatch("/regenerate but shorter", deps);
    expect(outcome).toMatchObject({
      kind: "handled",
      result: { kind: "toast", tone: "error", body: "/regenerate doesn't take arguments." },
    });
    expect(regenerateLast).not.toHaveBeenCalled();
  });

  it("still reach commands that take one", async () => {
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null } as Session],
      activeSessionId: "chat-1",
    });
    expect(await dispatch("/list nonsense", deps)).toMatchObject({
      result: { kind: "toast", tone: "error", body: 'Unknown list target "nonsense".' },
    });
  });
});
