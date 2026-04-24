import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Loader2,
  Plug,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useMcpStore, type McpServerView } from "@/stores/mcpStore";
import type { McpServerInput, McpTestResult } from "@/types";

/**
 * Settings → MCP panel. Two modes that swap in place:
 *   1. **List mode** — every configured server as a row (icon + name + URL
 *      + enabled toggle + edit / delete).
 *   2. **Editor mode** — form for adding or editing a single server, with a
 *      "Test connection" button that runs the handshake without saving.
 *
 * Loach only speaks the Streamable-HTTP transport, so every row is
 * ultimately just a URL + optional auth headers.
 */
export function McpPanel() {
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const hydrate = useMcpStore((s) => s.hydrate);
  const remove = useMcpStore((s) => s.remove);
  const save = useMcpStore((s) => s.save);

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
            Model Context Protocol servers expose external tools to the
            assistant. Add one by URL — Loach speaks the Streamable-HTTP
            transport.
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
              onDelete={() => void remove(srv.id)}
              onToggle={async (enabled) => {
                // Round-trip through `save` so we don't have to duplicate the
                // (id → full input) rebuild logic. The DB upsert keeps all
                // other fields because we pass them all through.
                await save({
                  id: srv.id,
                  name: srv.name,
                  url: srv.url,
                  headers: srv.headers,
                  enabled,
                });
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

  return (
    <li className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-foreground/[0.04]">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/70"
        title="Streamable HTTP"
      >
        <Plug className="h-4 w-4" />
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="truncate text-[13px] font-medium text-foreground/85">
          {server.name}
        </span>
        <span className="truncate font-mono text-[11px] text-foreground/50">
          {server.url || "(no URL)"}
        </span>
      </button>
      <Button
        variant={server.enabled ? "default" : "outline"}
        size="sm"
        disabled={toggling}
        onClick={async () => {
          setToggling(true);
          try {
            await onToggle(!server.enabled);
          } finally {
            setToggling(false);
          }
        }}
        className="h-7 px-3 text-[11px]"
      >
        {server.enabled ? "Enabled" : "Disabled"}
      </Button>
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

function McpEditor({ initial, onCancel, onSaved }: EditorProps) {
  const save = useMcpStore((s) => s.save);
  const test = useMcpStore((s) => s.test);

  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headersText, setHeadersText] = useState(
    initial?.headers
      ? Object.entries(initial.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const buildInput = (): McpServerInput => {
    const headers: Record<string, string> = {};
    headersText.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Accept both `K: V` (HTTP-ish) and `K=V` (env-ish). Pick whichever
      // comes first so values containing one character don't confuse the
      // other.
      const colon = trimmed.indexOf(":");
      const equals = trimmed.indexOf("=");
      const sep =
        colon === -1
          ? equals
          : equals === -1
            ? colon
            : Math.min(colon, equals);
      if (sep <= 0) return;
      headers[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
    });
    return {
      id: initial?.id,
      name: name.trim(),
      url: url.trim(),
      headers,
      enabled,
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
        <Label>Display name</Label>
        <Input
          className="mt-1.5"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GitHub"
        />
      </div>

      <Separator />

      <div>
        <Label>URL</Label>
        <Input
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
        <Label>Headers (one per line)</Label>
        <Textarea
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

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>Enabled</Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            Disabled servers stay in the config but don't surface to the
            model.
          </p>
        </div>
        <Button
          variant={enabled ? "default" : "outline"}
          onClick={() => setEnabled((v) => !v)}
          className="shrink-0"
        >
          {enabled ? "On" : "Off"}
        </Button>
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
      <div className="flex items-center gap-1.5 font-medium text-emerald-500">
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
