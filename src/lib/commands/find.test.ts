// `/find` in a chat with no messages: the welcome composer shows instead of a
// transcript, so there's no finder to open. The command used to do nothing
// and clear the composer without a word.

import { describe, it, expect } from "vitest";
import type { Session } from "@/types";
import { dispatch } from "./dispatch";
import { useChatStore } from "@/stores/chatStore";

const deps = { confirm: async () => true };

describe("/find", () => {
  it("says so in an empty chat", async () => {
    useChatStore.setState({
      sessions: [{ id: "chat-1", space_id: null } as Session],
      activeSessionId: "chat-1",
      messages: { "chat-1": [] },
    });
    expect(await dispatch("/find invoice", deps)).toMatchObject({
      result: { kind: "toast", title: "Nothing to find in an empty chat" },
    });
  });
});
