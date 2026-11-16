// "Clear all" removes the listed memories in one call and one list update;
// one by one it was a call and a re-render per memory (F9-12).

import { describe, it, expect, vi } from "vitest";
import type { GlobalMemory } from "@/types";

const mocks = vi.hoisted(() => ({
  removeMany: vi.fn((args: { ids: string[] }) => Promise.resolve(args.ids.length)),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, removeGlobalMemories: mocks.removeMany };
});

import { useGlobalMemoryStore } from "./globalMemoryStore";

const memory = (id: string) => ({ id, content: id, created_at: 0, updated_at: 0 }) as unknown as GlobalMemory;

describe("bulk memory removal", () => {
  it("removes the listed memories in one call and one update", async () => {
    useGlobalMemoryStore.setState({ memories: [memory("a"), memory("b"), memory("c")] });
    const updates = vi.fn();
    const unsubscribe = useGlobalMemoryStore.subscribe(updates);
    expect(await useGlobalMemoryStore.getState().removeMemories(["a", "b"])).toBe(2);
    unsubscribe();
    expect(mocks.removeMany).toHaveBeenCalledTimes(1);
    expect(mocks.removeMany).toHaveBeenCalledWith({ ids: ["a", "b"] });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(useGlobalMemoryStore.getState().memories?.map((m) => m.id)).toEqual(["c"]);
  });
});
