// What `prepareFiles` lets into the Library.
//
// A scanned PDF (no text layer) or an empty Word document comes back from
// extraction as a fixed note to the model. It used to be stored as the item's
// "content": a source with nothing in it, sharing one hash with every other
// such file — so the second one was flagged as already in the Library.

import { describe, it, expect, vi } from "vitest";
import type { Attachment } from "@/types";

const extracted = vi.hoisted(() => new Map<string, Partial<Attachment>>());

vi.mock("@/lib/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/files")>();
  return {
    ...actual,
    fileToAttachment: vi.fn(async (file: File) => ({ name: file.name, mime: file.type, ...extracted.get(file.name) })),
  };
});

import { NO_DOCX_TEXT, NO_PDF_TEXT } from "@/lib/files";
import { prepareFiles } from "./libraryStore";

describe("prepareFiles", () => {
  it("turns away documents with no readable text, keeps the rest", async () => {
    extracted.set("scan.pdf", { kind: "text", data: NO_PDF_TEXT });
    extracted.set("blank.docx", { kind: "text", data: NO_DOCX_TEXT });
    extracted.set("empty.md", { kind: "text", data: "  \n" });
    extracted.set("notes.md", { kind: "text", data: "real notes" });
    const files = ["scan.pdf", "blank.docx", "empty.md", "notes.md"].map((n) => new File(["x"], n));

    const { ready, failed } = await prepareFiles(files);

    expect(ready.map((f) => f.name)).toEqual(["notes.md"]);
    expect(failed.map((f) => f.name)).toEqual(["scan.pdf", "blank.docx", "empty.md"]);
    expect(failed[0].reason).toContain("scanned PDF");
  });
});
