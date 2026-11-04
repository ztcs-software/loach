// The canvas follows a streaming code block by its position among the
// message's fenced blocks, so the scan has to agree with the renderer on where
// each block ends.

import { describe, it, expect } from "vitest";
import { codeBlocks, lastCodeBlock } from "./codeBlocks";

describe("codeBlocks", () => {
  it("lists every block in order, the unterminated one last", () => {
    const md = "```html\n<p>hi</p>\n```\n\ntext\n\n~~~bash\necho hi";
    expect(codeBlocks(md)).toEqual([
      { code: "<p>hi</p>", language: "html" },
      { code: "echo hi", language: "bash" },
    ]);
    expect(lastCodeBlock(md)).toEqual({ code: "echo hi", language: "bash" });
  });

  it("keeps a quoted fence inside the block that quotes it", () => {
    const md = "````markdown\n```js\nlet a;\n```\n````";
    expect(codeBlocks(md)).toEqual([
      { code: "```js\nlet a;\n```", language: "markdown" },
    ]);
  });

  it("has nothing for prose", () => {
    expect(codeBlocks("no code here")).toEqual([]);
    expect(lastCodeBlock("no code here")).toBeNull();
  });
});
