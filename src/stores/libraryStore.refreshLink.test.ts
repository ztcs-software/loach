// A link refresh says whether it landed. It used to resolve the same either
// way, so the Add-link dialog, given a URL already in the Library, told a
// failed refresh from a fresh one by comparing the row's `updated_at`.

import { describe, it, expect, vi } from "vitest";
import type { LibraryItemMeta } from "@/types";

const libraryRefreshLink = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, libraryRefreshLink };
});

// The toast store arms its dismiss timers on `window`.
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
});

import { useLibraryStore } from "./libraryStore";
import { useToastStore } from "./toastStore";

const link = (updated_at: number) =>
  ({ id: "link-1", kind: "link", title: "Page", url: "https://example.com/", updated_at }) as LibraryItemMeta;

describe("refreshLink", () => {
  it("resolves true with the fresh row, and false — toasted — when it fails", async () => {
    useLibraryStore.setState({ items: [link(1)] });

    libraryRefreshLink.mockResolvedValueOnce(link(2));
    expect(await useLibraryStore.getState().refreshLink("link-1")).toBe(true);
    expect(useLibraryStore.getState().items[0]!.updated_at).toBe(2);

    libraryRefreshLink.mockRejectedValueOnce(new Error("offline"));
    expect(await useLibraryStore.getState().refreshLink("link-1")).toBe(false);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Couldn't refresh the link");
  });
});
