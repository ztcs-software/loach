import { create } from "zustand";
import { mcpDelete, mcpList, mcpSave, mcpTest } from "@/lib/tauri";
import { useToastStore } from "./toastStore";
import type {
  McpServer,
  McpServerInput,
  McpTestResult,
  McpTransport,
} from "@/types";

/** Parsed view of an `McpServer`: the JSON blobs (`headers_json`,
 *  `args_json`, `env_json`, `allowed_tools_json`) are decoded into plain
 *  values so the editor never has to touch `JSON.parse`. A parse failure
 *  falls back to empty so a corrupted row never crashes the settings tab. */
export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  url: string;
  headers: Record<string, string>;
  command: string;
  args: string[];
  env: Record<string, string>;
  auto_approve: boolean;
  allowed_tools: string[];
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Rebuild the full `mcp_save` / `mcp_test` input from a view — used by
 *  the enable toggle and the `/tools` command so neither has to know which
 *  fields belong to which transport. */
export function inputFromView(
  view: McpServerView,
  overrides: Partial<McpServerInput> = {},
): McpServerInput {
  return {
    id: view.id,
    name: view.name,
    transport: view.transport,
    url: view.url,
    headers: view.headers,
    command: view.command,
    args: view.args,
    env: view.env,
    auto_approve: view.auto_approve,
    allowed_tools: view.allowed_tools,
    enabled: view.enabled,
    ...overrides,
  };
}

/** One-line summary of how a server is reached — the URL, or the command
 *  line for stdio. */
export function connectionLabel(view: McpServerView): string {
  if (view.transport === "stdio") {
    return [view.command, ...view.args].filter(Boolean).join(" ") || "(no command)";
  }
  return view.url || "(no URL)";
}

interface McpState {
  servers: McpServerView[];
  loading: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  save: (input: McpServerInput) => Promise<McpServer>;
  remove: (id: string) => Promise<void>;
  test: (input: McpServerInput) => Promise<McpTestResult>;
}

function parseMap(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Decode a raw DB row into the editor-friendly shape. */
function viewFromRow(row: McpServer): McpServerView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "stdio" ? "stdio" : "http",
    url: row.url,
    headers: parseMap(row.headers_json),
    command: row.command ?? "",
    args: parseList(row.args_json),
    env: parseMap(row.env_json),
    auto_approve: row.auto_approve,
    allowed_tools: parseList(row.allowed_tools_json),
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,

  hydrate: async () => {
    await get().refresh();
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const rows = await mcpList();
      set({ servers: rows.map(viewFromRow), loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  save: async (input) => {
    const saved = await mcpSave(input);
    // Refetch rather than surgically patching so the list stays sorted the
    // same way the DB sorts it (by name).
    await get().refresh();
    return saved;
  },

  remove: async (id) => {
    try {
      await mcpDelete(id);
    } catch (e) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't delete server",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await get().refresh();
  },

  test: async (input) => {
    return mcpTest(input);
  },
}));
