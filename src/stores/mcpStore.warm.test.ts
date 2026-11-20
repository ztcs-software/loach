// Typing into the composer has the backend list the MCP servers' tools
// ahead of the send (`warmTools`): at most once a minute, and not at all
// without an enabled server.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { McpServerView } from "./mcpStore";

const mocks = vi.hoisted(() => ({
  mcpWarm: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, mcpWarm: mocks.mcpWarm };
});

import { useMcpStore } from "./mcpStore";

const server = (enabled: boolean) => ({ id: "s1", name: "fs", enabled }) as McpServerView;

describe("warmTools", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing without an enabled server", () => {
    vi.useFakeTimers({ now: 0 });
    useMcpStore.setState({ servers: [server(false)] });
    useMcpStore.getState().warmTools();
    expect(mocks.mcpWarm).not.toHaveBeenCalled();
  });

  it("asks once across keystrokes, and again a minute on", () => {
    vi.useFakeTimers({ now: 10_000_000 });
    useMcpStore.setState({ servers: [server(true)] });
    useMcpStore.getState().warmTools();
    useMcpStore.getState().warmTools();
    expect(mocks.mcpWarm).toHaveBeenCalledTimes(1);

    vi.setSystemTime(10_000_000 + 60_000);
    useMcpStore.getState().warmTools();
    expect(mocks.mcpWarm).toHaveBeenCalledTimes(2);
  });
});
