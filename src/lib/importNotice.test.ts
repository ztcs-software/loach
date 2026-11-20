// What a restore changed on its way in reaches the user after the reload:
// MCP servers brought back off or renamed, and a kept OpenAI-compatible URL.

import { describe, expect, it } from "vitest";
import { importNoticeText } from "./importNotice";
import type { ImportStats } from "@/types";

const stats = (fields: Partial<ImportStats>): ImportStats => ({
  sessions: 3,
  folders: 0,
  messages: 10,
  spaces: 0,
  space_files: 0,
  space_memories: 0,
  global_memories: 0,
  snippets: 0,
  snippet_variables: 0,
  snippet_fill_values: 0,
  mcp_servers: 2,
  settings: 5,
  library_items: 0,
  library_datasets: 0,
  mcp_disabled: [],
  mcp_renamed: [],
  openai_base_url_kept: false,
  ...fields,
});

describe("importNoticeText", () => {
  it("says nothing when the import changed nothing", () => {
    expect(importNoticeText(stats({}))).toBeNull();
  });

  it("names the servers that came back off, and where to turn them on", () => {
    const text = importNoticeText(stats({ mcp_disabled: ["files", "github"] }))!;
    expect(text).toMatch(/2 MCP servers were imported switched off \(files, github\)/);
    expect(text).toMatch(/Settings → MCP/);
    expect(importNoticeText(stats({ mcp_disabled: ["files"] }))).toMatch(/^1 MCP server was .* Turn it on/);
  });

  it("mentions renames and a kept OpenAI-compatible address", () => {
    const text = importNoticeText(stats({ mcp_renamed: ['"a b" → "a-b"'], openai_base_url_kept: true }))!;
    expect(text).toMatch(/"a b" → "a-b"/);
    expect(text).toMatch(/server address was kept/);
  });
});
