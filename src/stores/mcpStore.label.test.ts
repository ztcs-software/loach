// The MCP list and `/mcp` show each server's command line or URL. Servers
// take secrets there too (a database URL's password, `--api-key`), so the
// label masks them; the stored values are untouched.

import { describe, expect, it } from "vitest";
import { connectionLabel, redactArgs, redactUrl } from "./mcpStore";
import type { McpServerView } from "./mcpStore";

const stdio = (command: string, args: string[]) =>
  ({ transport: "stdio", command, args, url: "" }) as unknown as McpServerView;

describe("connection labels", () => {
  it("masks a URL's password and secret query values, nothing else", () => {
    expect(redactUrl("postgresql://user:hunter2@db.lan:5432/app")).toBe("postgresql://user:•••@db.lan:5432/app");
    expect(redactUrl("https://mcp.example.com/sse?token=abc123&team=core")).toBe(
      "https://mcp.example.com/sse?token=•••&team=core",
    );
    expect(redactUrl("https://mcp.example.com/sse?team=core")).toBe("https://mcp.example.com/sse?team=core");
  });

  it("masks secret flags' values and token-shaped arguments", () => {
    expect(redactArgs(["npx", "-y", "server", "--api-key", "abc", "--token=xyz", "--verbose"])).toEqual([
      "npx",
      "-y",
      "server",
      "--api-key",
      "•••",
      "--token=•••",
      "--verbose",
    ]);
    expect(redactArgs(["sk-proj-abcdef", "ghp_abcdefghij", "C:\\Users\\you\\Documents"])).toEqual([
      "•••",
      "•••",
      "C:\\Users\\you\\Documents",
    ]);
  });

  it("labels a stdio server with its secrets masked", () => {
    expect(
      connectionLabel(stdio("npx", ["-y", "@modelcontextprotocol/server-postgres", "postgresql://u:pw@h/db"])),
    ).toBe("npx -y @modelcontextprotocol/server-postgres postgresql://u:•••@h/db");
  });
});
