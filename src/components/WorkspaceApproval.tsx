/**
 * Human-readable previews for the workspace filesystem tools' consent
 * prompt (and the expanded tool-call block afterwards).
 *
 * The generic approval card prints a call's arguments as JSON. For
 * `write_file` that is a whole file as one escaped string, for `edit_file`
 * two of them — nothing a person can actually review, so they rubber-stamp.
 * Each mutating workspace tool gets a rendering that shows what the user
 * is being asked to allow: the file to be written, the edit as a `-`/`+`
 * diff, the move as `from → to`, the deletion in red.
 *
 * Read-only tools and anything from an MCP server return `null` and keep
 * the JSON view.
 */

import type { ReactNode } from "react";
import { ArrowRight, FilePlus, Pencil, Trash2 } from "lucide-react";
import { diffLines, splitLines } from "@/lib/lineDiff";
import { cn } from "@/lib/utils";

/** Synthetic server id the backend gives built-in tools
 *  (`tools::builtin::BUILTIN_SERVER_ID`). */
export const BUILTIN_SERVER_ID = "__builtin__";

export interface WorkspaceApproval {
  /** Completes "Allow the model to …?" — e.g. `write src/main.rs`. */
  title: ReactNode;
  body: ReactNode;
  /** Deletions get the red treatment; everything else stays amber. */
  destructive: boolean;
}

/** Characters of a `write_file` payload shown before the preview is cut.
 *  The full content is still written; this only bounds the card. */
const MAX_PREVIEW_CHARS = 20_000;
/** Diff rows shown before the rest is summarised. */
const MAX_DIFF_LINES = 400;

/** Build the preview for a built-in workspace tool call, or `null` when
 *  `tool` isn't one of the mutating workspace tools (or its arguments
 *  aren't the shape the backend would accept — the backend will refuse
 *  the call, and the JSON view shows why). */
export function workspaceApproval(tool: string, args: unknown): WorkspaceApproval | null {
  const o = argsObject(args);
  if (!o) return null;
  switch (tool) {
    case "write_file": {
      const path = str(o, "path");
      const content = str(o, "content");
      if (path === null || content === null) return null;
      return {
        title: (
          <>
            write <Mono>{path}</Mono>
          </>
        ),
        body: <WritePreview content={content} />,
        destructive: false,
      };
    }
    case "edit_file": {
      const path = str(o, "path");
      const oldText = str(o, "old_text");
      const newText = str(o, "new_text");
      if (path === null || oldText === null || newText === null) return null;
      return {
        title: (
          <>
            edit <Mono>{path}</Mono>
          </>
        ),
        body: (
          <>
            <DiffPreview oldText={oldText} newText={newText} />
            {o.replace_all === true && (
              <p className="mt-1.5 text-[11px] text-foreground/60">
                Replaces <span className="font-medium">every</span> occurrence of the
                removed text, not just the first.
              </p>
            )}
          </>
        ),
        destructive: false,
      };
    }
    case "move_file": {
      const from = str(o, "from");
      const to = str(o, "to");
      if (from === null || to === null) return null;
      return {
        title: (
          <>
            move <Mono>{from}</Mono>
          </>
        ),
        body: (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-foreground/80">
            <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5">{from}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-foreground/50" />
            <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5">{to}</span>
          </div>
        ),
        destructive: false,
      };
    }
    case "delete_file": {
      const path = str(o, "path");
      if (path === null) return null;
      return {
        title: (
          <>
            delete <Mono>{path}</Mono>
          </>
        ),
        body: (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-foreground/70">
            <Trash2 className="mt-px h-3.5 w-3.5 shrink-0 text-red-500" />
            <span>
              Removes <Mono>{path}</Mono> from disk. This can't be undone from Loach —
              only one file, or one empty directory, is removed per call.
            </span>
          </p>
        ),
        destructive: true,
      };
    }
    default:
      return null;
  }
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

function WritePreview({ content }: { content: string }) {
  const lines = splitLines(content).length;
  const bytes = new TextEncoder().encode(content).length;
  const clipped = content.length > MAX_PREVIEW_CHARS;
  const shown = clipped ? content.slice(0, MAX_PREVIEW_CHARS) : content;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-foreground/45">
        <FilePlus className="h-3 w-3" />
        New contents · {lines} {lines === 1 ? "line" : "lines"} · {bytes} bytes
      </div>
      <pre className="max-h-72 overflow-auto rounded border border-foreground/10 bg-foreground/[0.04] px-2 py-1.5 font-mono text-[11px] leading-snug text-foreground/80 whitespace-pre-wrap break-words">
        {shown}
        {clipped && (
          <span className="block pt-1 italic text-foreground/50">
            … preview cut at {MAX_PREVIEW_CHARS.toLocaleString()} characters; the whole file is
            written.
          </span>
        )}
      </pre>
    </div>
  );
}

function DiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const all = diffLines(oldText, newText);
  const rows = all.slice(0, MAX_DIFF_LINES);
  const hidden = all.length - rows.length;
  const removed = all.filter((l) => l.kind === "del").length;
  const added = all.filter((l) => l.kind === "add").length;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-foreground/45">
        <Pencil className="h-3 w-3" />
        Change ·{" "}
        <span className="text-red-600 dark:text-red-300">−{removed}</span>{" "}
        <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      </div>
      <pre className="max-h-72 overflow-auto rounded border border-foreground/10 bg-foreground/[0.04] py-1 font-mono text-[11px] leading-snug text-foreground/80">
        {rows.map((l, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-words px-2",
              l.kind === "del" && "bg-red-500/15 text-red-800 dark:text-red-200",
              l.kind === "add" && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
            )}
          >
            <span className="select-none text-foreground/40">
              {l.kind === "del" ? "- " : l.kind === "add" ? "+ " : "  "}
            </span>
            {l.text}
          </div>
        ))}
        {hidden > 0 && (
          <div className="px-2 pt-1 italic text-foreground/50">
            … {hidden} more {hidden === 1 ? "line" : "lines"}
          </div>
        )}
      </pre>
    </div>
  );
}

/** The model's arguments as an object. Some models ship a JSON string
 *  instead; parse it, and give up (→ generic JSON view) on anything else. */
function argsObject(args: unknown): Record<string, unknown> | null {
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" ? v : null;
}
