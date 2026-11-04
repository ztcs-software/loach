import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Library } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourcesReport } from "@/lib/sources";
import { useLibraryStore } from "@/stores/libraryStore";
import type { ToolCallRecord } from "@/types";

/**
 * What an answer drew on: "Read 3 sources in full" or "Used 6 excerpts from
 * 3 sources", expandable to the sources and the excerpts themselves. Built
 * from the `library_sources` record the send path attaches to the reply.
 */
export function SourcesUsedChip({ record }: { record: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const report = record.arguments as SourcesReport;
  const items = useLibraryStore((s) => s.items);
  const openPreview = useLibraryStore((s) => s.openPreview);
  const sources = report?.sources ?? [];
  const warning = report?.warning ?? null;
  const known = new Set(items.map((i) => i.id));

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 text-xs transition-colors",
          record.is_error ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground hover:text-foreground/70",
        )}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {record.is_error || warning ? (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <Library className="h-3.5 w-3.5" />
        )}
        <span>{record.result}</span>
      </button>
      {open && (
        <div className="ml-5 mt-1.5 space-y-1.5">
          {warning && (
            <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11.5px] text-amber-800 dark:text-amber-200">
              {warning}
            </p>
          )}
          {report?.mode === "retrieval" && report.method === "keyword" && !warning && (
            <p className="text-[11px] text-foreground/45">
              Matched by keyword — set an embedding model in Settings → Library to also match by meaning.
            </p>
          )}
          {sources.map((s) => (
            <SourceEntry
              key={`${s.kind}:${s.id}`}
              title={s.title}
              excerpts={s.excerpts}
              onOpen={s.kind === "library" && known.has(s.id) ? () => openPreview(s.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceEntry({
  title,
  excerpts,
  onOpen,
}: {
  title: string;
  excerpts?: { seq: number; text: string }[];
  onOpen?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 truncate font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate font-medium text-foreground/80">{title}</span>
        )}
        {excerpts && excerpts.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto shrink-0 text-[10.5px] text-foreground/45 hover:text-foreground/70"
          >
            {expanded ? "Hide" : `${excerpts.length} excerpt${excerpts.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
      {expanded &&
        excerpts?.map((e) => (
          <div key={e.seq} className="mt-1.5 border-l-2 border-foreground/10 pl-2">
            <div className="text-[10px] uppercase tracking-wider text-foreground/40">Part {e.seq + 1}</div>
            <p className="line-clamp-6 whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/70">{e.text}</p>
          </div>
        ))}
    </div>
  );
}
