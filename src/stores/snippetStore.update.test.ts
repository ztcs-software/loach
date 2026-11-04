// Saving a snippet clears its legacy attachments in the database — and must
// in memory too, or an edited snippet kept running with its old files until
// the next restart.

import { describe, it, expect } from "vitest";
import type { Snippet } from "@/types";
import { useSnippetStore } from "./snippetStore";

describe("snippet update", () => {
  it("drops the attachments it drops from the row", async () => {
    useSnippetStore.setState({
      snippets: [{ id: "s1", title: "Old", prompt: "p", attachments_json: '[{"kind":"text"}]' } as Snippet],
    });
    await useSnippetStore.getState().update("s1", "New", "p2", null, null);
    expect(useSnippetStore.getState().snippets[0]).toMatchObject({
      title: "New",
      prompt: "p2",
      attachments_json: null,
    });
  });
});
