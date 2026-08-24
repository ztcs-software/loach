import { create } from "zustand";
import { mcpDelete, mcpList, mcpSave, mcpTest } from "@/lib/tauri";
import { useToastStore } from "./toastStore";
import type {
  McpServer,
  McpServerInput,
  McpTestResult,
} from "@/types";

/** Parsed view of an `McpServer`: the `headers_json` blob is decoded into a
 *  plain `Record` so the editor never has to touch `JSON.parse`. A parse
 *  failure falls back to an empty map so a corrupted row never crashes the
 *  settings tab. */
export interface McpServerView {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  created_at: number;
  updated_at: number;
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

/** Decode a raw DB row into the editor-friendly shape. */
function viewFromRow(row: McpServer): McpServerView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    headers: parseMap(row.headers_json),
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
