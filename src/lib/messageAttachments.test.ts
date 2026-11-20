// A chat loaded from disk lists its attachments without their contents
// (`omitted`); `loadAttachments` fetches them for one message, and only when
// they're missing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  messageAttachments: vi.fn<typeof import("@/lib/tauri").messageAttachments>(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, messageAttachments: mocks.messageAttachments };
});

import { loadAttachments, parseAttachments } from "./messageAttachments";

const full = [{ kind: "image", name: "cat.png", mime: "image/png", data: "iVBORw0K" }];
const listed = [{ kind: "image", name: "cat.png", mime: "image/png", omitted: true }];
const message = (attachments: unknown) => ({
  id: "m1",
  session_id: "c1",
  attachments_json: attachments === null ? null : JSON.stringify(attachments),
});

describe("parseAttachments", () => {
  it("gives a listed attachment empty contents, and nothing for bad JSON", () => {
    expect(parseAttachments(JSON.stringify(listed))).toEqual([{ ...listed[0], data: "" }]);
    expect(parseAttachments("not json")).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
  });
});

describe("loadAttachments", () => {
  beforeEach(() => {
    mocks.messageAttachments.mockReset();
    mocks.messageAttachments.mockResolvedValue(JSON.stringify(full));
  });

  it("fetches the contents a listed message left out", async () => {
    await expect(loadAttachments(message(listed))).resolves.toEqual(full);
    expect(mocks.messageAttachments).toHaveBeenCalledWith("c1", "m1");
  });

  it("asks for nothing when the contents are already there", async () => {
    await expect(loadAttachments(message(full))).resolves.toEqual(full);
    await expect(loadAttachments(message(null))).resolves.toEqual([]);
    expect(mocks.messageAttachments).not.toHaveBeenCalled();
  });
});
