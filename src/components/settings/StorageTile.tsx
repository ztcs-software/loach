//! Settings -> Data: a read-only breakdown of what Loach is storing.
//!
//! Sits above the export / import / erase rows so "how big is this?" is
//! answered before the user reaches for a destructive control.

import type { StorageStats } from "@/types";
import { Database, HardDrive, Loader2 } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { storageStats } from "@/lib/tauri";
import { useEffect, useState } from "react";
import { useModelsStore } from "@/stores/modelsStore";

export function StorageTile() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Model sizes are already in the store — `App` hydrates them at boot, so
  // by the time Settings opens this is a plain read with no extra IPC.
  const models = useModelsStore((s) => s.models);
  const local = models.filter((m) => m.provider === "ollama");
  const localBytes = local.reduce((sum, m) => sum + (m.size ?? 0), 0);

  // The Data tab unmounts this on any tab switch and on Escape, both of
  // which are reachable while the scan is still running on a large
  // database — hence the cancelled flag rather than a bare setState.
  useEffect(() => {
    let cancelled = false;
    storageStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="divide-y divide-foreground/[0.06] rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
      <section className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-foreground/75">
            <Database className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-4">
              <h4 className="text-[13.5px] font-medium text-foreground">
                Database
              </h4>
              {stats && (
                <span className="shrink-0 text-[12.5px] tabular-nums text-foreground/75">
                  {formatBytes(stats.db_bytes + stats.wal_bytes)} on disk
                </span>
              )}
            </div>

            {loading && (
              <p className="mt-1 flex items-center gap-1.5 text-[12px] text-foreground/55">
                <Loader2 className="h-3 w-3 animate-spin" />
                Measuring…
              </p>
            )}

            {error && (
              <p className="mt-1 text-[12px] leading-relaxed text-destructive">
                {error}
              </p>
            )}

            {!loading && !error && !stats && (
              <p className="mt-1 text-[12px] leading-relaxed text-foreground/55">
                Storage details are only available in the desktop app.
              </p>
            )}

            {stats && (
              <>
                <p
                  className="mt-1 truncate font-mono text-[11px] text-foreground/50"
                  title={stats.db_path}
                >
                  {stats.db_path}
                </p>

                <dl className="mt-3 space-y-1.5">
                  <StorageLine
                    label="Chats"
                    detail={`${count(stats.messages)} message${stats.messages === 1 ? "" : "s"} across ${count(stats.sessions)} chat${stats.sessions === 1 ? "" : "s"}`}
                    bytes={stats.message_bytes}
                  />
                  <StorageLine
                    label="Attachments"
                    detail="Inlined into messages and snippets"
                    bytes={stats.attachment_bytes}
                  />
                  <StorageLine
                    label="Spaces"
                    detail={`${count(stats.spaces)} space${stats.spaces === 1 ? "" : "s"} · ${count(stats.space_files)} file${stats.space_files === 1 ? "" : "s"}`}
                    bytes={stats.space_bytes}
                  />
                  <StorageLine
                    label="Other"
                    detail={`${count(stats.snippets)} snippet${stats.snippets === 1 ? "" : "s"} · ${count(stats.mcp_servers)} MCP server${stats.mcp_servers === 1 ? "" : "s"} · settings`}
                    bytes={stats.other_bytes}
                  />
                </dl>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="flex items-start justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-foreground/75">
            <HardDrive className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-[13.5px] font-medium text-foreground">
              Local models
            </h4>
            <p className="mt-1 text-[12px] leading-relaxed text-foreground/55">
              {local.length === 0
                ? "No local models found. Ollama may not be running."
                : `${count(local.length)} model${local.length === 1 ? "" : "s"}, as reported by Ollama. They're stored by Ollama, not by Loach, and live outside the folder above.`}
            </p>
          </div>
        </div>
        {local.length > 0 && (
          <span className="shrink-0 text-[12.5px] tabular-nums text-foreground/75">
            {formatBytes(localBytes)}
          </span>
        )}
      </section>
    </div>
  );
}

/** One label / detail / size line of the database breakdown. */
function StorageLine({
  label,
  detail,
  bytes,
}: {
  label: string;
  detail: string;
  bytes: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="min-w-0 text-[12px] text-foreground/60">
        <span className="text-foreground/80">{label}</span>
        <span className="ml-2 text-foreground/50">{detail}</span>
      </dt>
      <dd className="shrink-0 text-[12px] tabular-nums text-foreground/70">
        {formatBytes(bytes)}
      </dd>
    </div>
  );
}

const count = (n: number) => n.toLocaleString();
