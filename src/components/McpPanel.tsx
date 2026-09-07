import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Loader2,
  Plug,
  Plus,
  ShieldAlert,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  connectionLabel,
  inputFromView,
  useMcpStore,
  type McpServerView,
} from "@/stores/mcpStore";
import { useToastStore } from "@/stores/toastStore";
import { cn } from "@/lib/utils";
import type { McpServerInput, McpTestResult, McpTransport } from "@/types";

/**
 * Settings → MCP panel. Two modes that swap in place:
 *   1. **List mode** — every configured server as a row (transport icon +
 *      name + URL-or-command + enabled toggle + delete).
 *   2. **Editor mode** — form for adding or editing a single server, with a
 *      "Test connection" button that runs the handshake without saving.
 *
 * Two transports: Streamable HTTP (a URL plus optional auth headers) and
 * stdio (a command Loach spawns and talks to over its pipes). Saving or
 * testing a stdio config also raises a native OS dialog quoting the exact
 * command line — that dialog is the consent gate for running a local
 * program, and it lives in the backend on purpose (see
 * `commands::confirm_stdio_spawn`).
 */
export function McpPanel() {
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const hydrate = useMcpStore((s) => s.hydrate);
  const remove = useMcpStore((s) => s.remove);
  const save = useMcpStore((s) => s.save);
  const { confirm } = useConfirm();

  /** When non-null, the editor is open. "new" means creating; otherwise
   *  it's the id of the server being edited. */
  const [editing, setEditing] = useState<null | "new" | string>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const editingServer = useMemo<McpServerView | null>(() => {
    if (!editing || editing === "new") return null;
    return servers.find((s) => s.id === editing) ?? null;
  }, [editing, servers]);

  if (editing) {
    return (
      <McpEditor
        key={editing}
        initial={editingServer}
        onCancel={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight">
            MCP integrations
          </h3>
          <p className="mt-1 text-[13px] text-foreground/60">
            Model Context Protocol (MCP) servers expose external tools to the
            models. Every tool call asks for your approval unless you say
            otherwise per server.
          </p>
        </div>
        <Button
          onClick={() => setEditing("new")}
          className="shrink-0 gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Add server
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && servers.length === 0 ? (
        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-4 py-10 text-sm text-foreground/55">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : servers.length === 0 ? (
        <EmptyState onAdd={() => setEditing("new")} />
      ) : (
        <ul className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 bg-foreground/[0.03]">
          {servers.map((srv) => (
            <ServerRow
              key={srv.id}
              server={srv}
              onEdit={() => setEditing(srv.id)}
              onDelete={() =>
                void (async () => {
                  // Every other destructive delete in the app confirms
                  // first, and this button sits right beside the enable
                  // toggle — a slip permanently destroyed the URL and any
                  // auth headers, with no undo.
                  const ok = await confirm({
                    title: "Delete this MCP server?",
                    body:
                      srv.transport === "stdio"
                        ? `“${srv.name}” will be removed, along with its command and any environment variables. This can't be undone.`
                        : `“${srv.name}” will be removed, along with its URL and any auth headers. This can't be undone.`,
                    confirmLabel: "Delete server",
                    destructive: true,
                  });
                  if (ok) await remove(srv.id);
                })()
              }
              onToggle={async (enabled) => {
                // Round-trip through `save` so we don't have to duplicate the
                // (id → full input) rebuild logic. The DB upsert keeps all
                // other fields because we pass them all through.
                await save(inputFromView(srv, { enabled }));
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-8 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-foreground/[0.06] text-foreground/60">
        <Plug className="h-4 w-4" />
      </div>
      <h2 className="mt-3 text-sm font-medium">No MCP servers yet</h2>
      <p className="mt-1 max-w-md text-[12px] text-foreground/55">
        Connect an MCP server to give the assistant access to external tools
        like databases, issue trackers, or custom scripts.
      </p>
      <Button onClick={onAdd} size="sm" className="mt-4 gap-1.5">
        <Plus className="h-4 w-4" />
        Add your first server
      </Button>
    </div>
  );
}

function ServerRow({
  server,
  onEdit,
  onDelete,
  onToggle,
}: {
  server: McpServerView;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);
  const stdio = server.transport === "stdio";

  return (
    <li className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-foreground/[0.04]">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/70"
        title={stdio ? "Local process (stdio)" : "Streamable HTTP"}
      >
        {stdio ? (
          <SquareTerminal className="h-4 w-4" />
        ) : (
          <Plug className="h-4 w-4" />
        )}
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground/85">
            {server.name}
          </span>
          {server.auto_approve && (
            <span
              className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
              title="Tool calls from this server run without asking"
            >
              Auto-approve
            </span>
          )}
        </span>
        <span className="max-w-full truncate font-mono text-[11px] text-foreground/50">
          {connectionLabel(server)}
        </span>
      </button>
      <Switch
        checked={server.enabled}
        disabled={toggling}
        onCheckedChange={async (next) => {
          setToggling(true);
          try {
            await onToggle(next);
          } catch (e) {
            // The Switch is controlled by `server.enabled`; because `save`
            // threw before `refresh()` ran, it snaps back to its prior
            // position — so without this toast the revert looks like a ghost.
            // (For a stdio server that includes "Cancel" on the consent
            // dialog — the server simply stays off.)
            useToastStore.getState().push({
              kind: "error",
              title: "Couldn't update server",
              body: e instanceof Error ? e.message : String(e),
            });
          } finally {
            setToggling(false);
          }
        }}
        aria-label={server.enabled ? "Disable server" : "Enable server"}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        aria-label="Delete MCP server"
        className="h-7 w-7 rounded-full text-foreground/55 hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface EditorProps {
  /** Null when creating a new server, otherwise the existing row. */
  initial: McpServerView | null;
  onCancel: () => void;
  onSaved: () => void;
}

/** Parse `KEY: value` / `KEY=value` lines into a map. Accepts both
 *  separators, picking whichever comes first so a value containing the
 *  other character survives. */
function parseKvLines(text: string, separators: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  text.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let sep = -1;
    for (const ch of separators) {
      const i = trimmed.indexOf(ch);
      if (i !== -1 && (sep === -1 || i < sep)) sep = i;
    }
    if (sep <= 0) return;
    out[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
  });
  return out;
}

function kvToLines(map: Record<string, string>, sep: string): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

function McpEditor({ initial, onCancel, onSaved }: EditorProps) {
  const save = useMcpStore((s) => s.save);
  const test = useMcpStore((s) => s.test);

  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "http");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headersText, setHeadersText] = useState(
    initial?.headers ? kvToLines(initial.headers, ": ") : "",
  );
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState(initial?.args.join("\n") ?? "");
  const [envText, setEnvText] = useState(initial?.env ? kvToLines(initial.env, "=") : "");
  const [askEachCall, setAskEachCall] = useState(!(initial?.auto_approve ?? false));
  const [allowedTools, setAllowedTools] = useState<string[]>(initial?.allowed_tools ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const buildInput = (): McpServerInput => {
    const base = {
      id: initial?.id,
      name: name.trim(),
      transport,
      auto_approve: !askEachCall,
      allowed_tools: allowedTools,
      enabled,
    };
    if (transport === "stdio") {
      return {
        ...base,
        command: command.trim(),
        args: argsText
          .split("\n")
          .map((a) => a.trim())
          .filter((a) => a.length > 0),
        // `=` only: an env value routinely contains `:` (paths, URLs).
        env: parseKvLines(envText, ["="]),
      };
    }
    return {
      ...base,
      url: url.trim(),
      headers: parseKvLines(headersText, [":", "="]),
    };
  };

  const handleSave = async () => {
    setSaveError(null);
    setBusy("save");
    try {
      await save(buildInput());
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    setBusy("test");
    try {
      const r = await test(buildInput());
      setTestResult(r);
    } catch (e) {
      setTestResult({
        ok: false,
        server_name: null,
        server_version: null,
        protocol_version: null,
        tools: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onCancel}
          aria-label="Back"
          className="h-8 w-8 rounded-full text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-lg font-semibold tracking-tight">
          {initial ? "Edit MCP server" : "Add MCP server"}
        </h3>
      </div>

      <div>
        <Label htmlFor="mcp-name">Display name</Label>
        <Input
          id="mcp-name"
          className="mt-1.5"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GitHub"
        />
      </div>

      <div>
        <Label>Transport</Label>
        <TransportSwitch value={transport} onChange={setTransport} />
        <p className="mt-1.5 text-[11px] text-foreground/50">
          {transport === "stdio"
            ? "Loach starts the program and talks to it over its standard input and output. This is how most published MCP servers run (npx, uvx, a local binary)."
            : "Loach sends JSON-RPC requests to a URL. Use this for hosted servers and gateways."}
        </p>
      </div>

      <Separator />

      {transport === "http" ? (
        <>
          <div>
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              className="mt-1.5 font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
            />
            <p className="mt-1.5 text-[11px] text-foreground/50">
              The Streamable-HTTP endpoint where JSON-RPC bodies are POSTed.
            </p>
          </div>

          <div>
            <Label htmlFor="mcp-headers">Headers (one per line)</Label>
            <Textarea
              id="mcp-headers"
              rows={3}
              className="mt-1.5 resize-none font-mono text-xs"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={"Authorization: Bearer sk-…\nX-API-Key: …"}
            />
            <p className="mt-1.5 text-[11px] text-foreground/50">
              Use <span className="font-mono">Key: value</span> pairs — one per
              line. Typically auth tokens.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              className="mt-1.5 font-mono"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
            <p className="mt-1.5 text-[11px] text-foreground/50">
              A program on your PATH (<span className="font-mono">npx</span>,{" "}
              <span className="font-mono">uvx</span>,{" "}
              <span className="font-mono">node</span>) or a full path to one.
            </p>
          </div>

          <div>
            <Label htmlFor="mcp-args">Arguments (one per line)</Label>
            <Textarea
              id="mcp-args"
              rows={3}
              className="mt-1.5 resize-none font-mono text-xs"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Documents"}
            />
            <p className="mt-1.5 text-[11px] text-foreground/50">
              One argument per line — no shell quoting needed, spaces are
              kept as typed.
            </p>
          </div>

          <div>
            <Label htmlFor="mcp-env">Environment variables (one per line)</Label>
            <Textarea
              id="mcp-env"
              rows={3}
              className="mt-1.5 resize-none font-mono text-xs"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…"}
            />
            <p className="mt-1.5 text-[11px] text-foreground/50">
              <span className="font-mono">NAME=value</span> pairs layered over
              Loach's own environment. This is where most servers take their
              API keys. Left out of backups, like HTTP headers.
            </p>
          </div>

          <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3 text-[12px] text-foreground/75">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p>
              This runs a program on your computer with your permissions.
              Before Loach starts it for the first time — on Save or Test —
              a system dialog shows the exact command so you can check it.
            </p>
          </div>
        </>
      )}

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>Ask before each tool call</Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            Every call from this server shows what the model wants to run
            and waits for you. Turn this off only for servers whose tools
            can't do harm on their own.
          </p>
        </div>
        <Switch
          checked={askEachCall}
          onCheckedChange={setAskEachCall}
          className="shrink-0"
          aria-label={askEachCall ? "Stop asking before each tool call" : "Ask before each tool call"}
        />
      </div>

      {askEachCall && allowedTools.length > 0 && (
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-foreground/80">
              Always allowed ({allowedTools.length})
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setAllowedTools([])}
            >
              Ask again for all
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-foreground/50">
            Tools you answered “Always allow” for in a chat. They run
            without a prompt until you reset them here.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {allowedTools.map((t) => (
              <li
                key={t}
                className="rounded-md border border-foreground/10 bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-foreground/75"
              >
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>Enabled</Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            Disabled servers stay in the config but don't surface to the
            model.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          className="shrink-0"
          aria-label={enabled ? "Disable server" : "Enable server"}
        />
      </div>

      {saveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {saveError}
        </div>
      )}

      {testResult && <TestResultCard result={testResult} />}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={busy !== null}
          className="gap-1.5"
        >
          {busy === "test" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          Test connection
        </Button>
        <Button onClick={handleSave} disabled={busy !== null}>
          {busy === "save" ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : null}
          Save
        </Button>
      </div>
    </div>
  );
}

const TRANSPORT_OPTIONS: { value: McpTransport; label: string; icon: typeof Plug }[] = [
  { value: "http", label: "Streamable HTTP", icon: Plug },
  { value: "stdio", label: "Local process (stdio)", icon: SquareTerminal },
];

/** Two-way segmented control, styled like the General tab's switches. */
function TransportSwitch({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (next: McpTransport) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Transport"
      className="mt-1.5 grid grid-cols-2 gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-1"
    >
      {TRANSPORT_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium transition-colors",
              selected
                ? "bg-primary/10 text-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]"
                : "text-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TestResultCard({ result }: { result: McpTestResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
        <div className="flex items-center gap-1.5 font-medium">
          <CircleAlert className="h-4 w-4" />
          Connection failed
        </div>
        <p className="mt-1 text-[12px] text-destructive/90 break-words">
          {result.error ?? "Unknown error"}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px]">
      <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        Connected
      </div>
      <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-foreground/75">
        {result.server_name && (
          <>
            <span className="text-foreground/50">Server</span>
            <span className="font-mono">
              {result.server_name}
              {result.server_version ? ` · ${result.server_version}` : ""}
            </span>
          </>
        )}
        {result.protocol_version && (
          <>
            <span className="text-foreground/50">Protocol</span>
            <span className="font-mono">{result.protocol_version}</span>
          </>
        )}
        <span className="text-foreground/50">Tools</span>
        <span>{result.tools.length}</span>
      </div>
      {result.tools.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-foreground/[0.04] p-2">
          {result.tools.map((t) => (
            <li
              key={t.name}
              className="truncate font-mono text-[11px] text-foreground/70"
              title={t.description ?? undefined}
            >
              {t.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
