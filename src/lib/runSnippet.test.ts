// Running a snippet in a fresh chat: the chat is created only once the
// prompt is final.
//
// The Snippets page and the search palette used to create the chat (and
// navigate to it) before the fill-blanks dialog opened, so cancelling that
// dialog stranded the user in an empty chat, away from where they started.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snippet } from "@/types";
import { expandAndPrimeSnippet } from "./runSnippet";
import { useSnippetVarStore } from "@/stores/snippetVarStore";
import { useUIStore } from "@/stores/uiStore";

const snippet = (prompt: string): Snippet => ({
  id: "sn",
  title: "Review",
  prompt,
  attachments_json: null,
  provider: null,
  model: null,
  created_at: 0,
  updated_at: 0,
});

/** Wait for the fill dialog's request — it lands after the recall lookup. */
async function pendingFill() {
  await vi.waitFor(() => expect(useSnippetVarStore.getState().pendingFill).not.toBeNull());
  return useSnippetVarStore.getState().pendingFill!;
}

beforeEach(() => {
  useSnippetVarStore.setState({ variables: [], pendingFill: null, fillValuesBySnippet: {} });
  useUIStore.setState({ composerDraft: "", composerInsertSeq: 0 });
});

describe("expandAndPrimeSnippet", () => {
  it("never opens the chat when the fill dialog is cancelled", async () => {
    const openChat = vi.fn(async () => undefined);
    const run = expandAndPrimeSnippet(snippet("Review {{LANGUAGE}} code"), openChat);

    (await pendingFill()).onCancel();
    await run;

    expect(openChat).not.toHaveBeenCalled();
    expect(useUIStore.getState().composerDraft).toBe("");
  });

  it("opens the chat, then primes it, once the blanks are filled", async () => {
    const order: string[] = [];
    const openChat = vi.fn(async () => {
      order.push(`chat (draft "${useUIStore.getState().composerDraft}")`);
    });
    const run = expandAndPrimeSnippet(snippet("Review {{LANGUAGE}} code"), openChat);

    const fill = await pendingFill();
    fill.onSubmit("Review Rust code", { LANGUAGE: "Rust" });
    await run;

    expect(order).toEqual(['chat (draft "")']);
    expect(useUIStore.getState().composerDraft).toBe("Review Rust code");
  });

  it("opens the chat straight away when nothing needs filling", async () => {
    const openChat = vi.fn(async () => undefined);
    await expandAndPrimeSnippet(snippet("Summarise this"), openChat);
    expect(openChat).toHaveBeenCalledOnce();
    expect(useUIStore.getState().composerDraft).toBe("Summarise this");
  });
});
