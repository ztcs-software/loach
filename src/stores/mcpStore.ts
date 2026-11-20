import { create } from "zustand";
import { mcpDelete, mcpList, mcpSave, mcpTest, mcpWarm } from "@/lib/tauri";
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
    return redactArgs([view.command, ...view.args]).filter(Boolean).join(" ") || "(no command)";
  }
  return redactUrl(view.url) || "(no URL)";
}

/** What masked text shows instead. */
const MASK = "•••";
/** A name that says its value is a secret — `--api-key`, `?access_token=`,
 *  `X-Amz-Signature` — as a whole segment of it, so `--author` or
 *  `--design` don't count. */
const SECRET_NAME =
  /(?:^|[-_.])(?:api[-_]?key|key|token|secret|passw(?:or)?d|pwd|auth(?:orization)?|credentials?|sig(?:nature)?)(?:$|[-_.])/i;
const isSecretName = (name: string) => SECRET_NAME.test(name.replace(/^-+/, "").replace(/=$/, ""));

/** `text` with the secrets a URL can carry masked: the password in its
 *  userinfo (`postgresql://user:pw@host`) and secret-named query values
 *  (`?token=…`). Display only — the list showed them to anyone looking. */
export function redactUrl(text: string): string {
  return text
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/gi, `$1${MASK}@`)
    .replace(/([?&]([^=&#\s]*)=)([^&#\s]*)/g, (all, head: string, name: string) =>
      isSecretName(name) ? `${head}${MASK}` : all,
    );
}

/** A token's shape: a known key prefix, or a long run of key characters
 *  with letters and digits both. */
function looksLikeToken(arg: string): boolean {
  if (/^(?:sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[abprs])[-_]\w/i.test(arg)) return true;
  return /^[A-Za-z0-9_-]{32,}$/.test(arg) && /\d/.test(arg) && /[A-Za-z]/.test(arg);
}

/** A command line's parts with their secrets masked: URLs as in
 *  `redactUrl`, the value of a secret-named flag (`--api-key X`,
 *  `--token=X`) and token-shaped arguments. */
export function redactArgs(parts: string[]): string[] {
  return parts.map((part, i) => {
    const prev = i > 0 ? parts[i - 1] : "";
    if (/^-/.test(prev) && !prev.includes("=") && isSecretName(prev) && !/^-/.test(part)) return MASK;
    const flag = /^(-{1,2}[^=\s]+=)(.+)$/.exec(part);
    if (flag && isSecretName(flag[1])) return `${flag[1]}${MASK}`;
    if (looksLikeToken(part)) return MASK;
    return redactUrl(part);
  });
}

interface McpState {
  servers: McpServerView[];
  loading: boolean;
  error: string | null;
  /** When a `warmTools` listing last finished, so the context bar can count
   *  the tools it cached; 0 before one has. */
  toolsWarmedAt: number;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  save: (input: McpServerInput) => Promise<McpServer>;
  remove: (id: string) => Promise<void>;
  test: (input: McpServerInput) => Promise<McpTestResult>;
  /** Have the backend list the enabled servers' tools ahead of a send, as
   *  the user types: the first send of a launch otherwise waited for every
   *  stdio server to start. At most once a minute; nothing without an
   *  enabled server. */
  warmTools: () => void;
}

/** When `warmTools` last asked, so keystrokes don't each ask. */
let lastWarm = 0;
const WARM_INTERVAL_MS = 60_000;

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

/** See `refresh`. */
let refreshSeq = 0;

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  toolsWarmedAt: 0,

  hydrate: async () => {
    await get().refresh();
  },

  refresh: async () => {
    // Only the latest refresh lands: two in quick succession (two switches
    // flipped) could resolve out of order, and the older list won.
    const seq = ++refreshSeq;
    set({ loading: true, error: null });
    try {
      const rows = await mcpList();
      if (seq !== refreshSeq) return;
      set({ servers: rows.map(viewFromRow), loading: false });
    } catch (e) {
      if (seq !== refreshSeq) return;
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

  warmTools: () => {
    if (!get().servers.some((s) => s.enabled)) return;
    const now = Date.now();
    if (now - lastWarm < WARM_INTERVAL_MS) return;
    lastWarm = now;
    void mcpWarm().then(
      () => set({ toolsWarmedAt: Date.now() }),
      () => {},
    );
  },
}));
