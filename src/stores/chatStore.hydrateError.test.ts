// A failed chat load isn't an empty install (F5-05).
//
// `hydrate` caught the failure and left an empty list, so the app said "No
// chat open" and the sidebar "Your conversations will appear here" over a
// database it couldn't read.

import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ fail: true }));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    listSessions: vi.fn(async () => {
      if (db.fail) throw new Error("database is locked");
      return [];
    }),
  };
});

import { useChatStore } from "./chatStore";

describe("chatStore.hydrate", () => {
  it("records why the load failed, and clears it once a retry succeeds", async () => {
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState()).toMatchObject({ hydrated: true, loadError: "database is locked" });

    db.fail = false;
    await useChatStore.getState().hydrate();
    expect(useChatStore.getState().loadError).toBeNull();
  });
});
