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

import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, FilePlus, FileWarning, Pencil, Trash2 } from "lucide-react";
import { diffLines, foldUnchanged, splitHidden, splitLines } from "@/lib/lineDiff";
import { cn, formatBytes } from "@/lib/utils";

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

/** Characters of a `write_file` payload shown before the preview is cut —
 *  until "Show all". The full content is still written; this only bounds
 *  the card. */
const MAX_PREVIEW_CHARS = 20_000;
/** Diff rows shown before the rest is summarised — until "Show all". */
const MAX_DIFF_LINES = 400;

/** Build the preview for a built-in workspace tool call, or `null` when
 *  `tool` isn't one of the mutating workspace tools (or its arguments
 *  aren't the shape the backend would accept — the backend will refuse
 *  the call, and the JSON view shows why). `existingBytes` is the backend's
 *  word on what a `write_file` replaces (`ToolCallRecord.existing_bytes`). */
export function workspaceApproval(
  tool: string,
  args: unknown,
  existingBytes?: number | null,
): WorkspaceApproval | null {
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
        body: <WritePreview content={content} existingBytes={existingBytes} />,
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
            <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5">
              <Revealed text={from} />
            </span>
            <ArrowRight className="h-3 w-3 shrink-0 text-foreground/50" />
            <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5">
              <Revealed text={to} />
            </span>
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
  return <span className="font-mono">{typeof children === "string" ? <Revealed text={children} /> : children}</span>;
}

/** `text` with every character that would otherwise display as nothing —
 *  or reorder what's around it — drawn as a visible `U+202E` tag
 *  (`splitHidden`), so what the user approves reads the way it's written. */
function Revealed({ text }: { text: string }) {
  const pieces = splitHidden(text);
  if (pieces.length === 1 && typeof pieces[0] === "string") return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        typeof piece === "string" ? (
          piece
        ) : (
          <span
            key={i}
            className="mx-px rounded-sm bg-amber-500/25 px-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-200"
            title="An invisible character: it changes how the text around it displays"
          >
            {piece.hidden}
          </span>
        ),
      )}
    </>
  );
}

function WritePreview({
  content,
  existingBytes,
}: {
  content: string;
  existingBytes?: number | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => splitLines(content).length, [content]);
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const clipped = !showAll && content.length > MAX_PREVIEW_CHARS;
  const shown = clipped ? content.slice(0, MAX_PREVIEW_CHARS) : content;
  const size = `${lines} ${lines === 1 ? "line" : "lines"} · ${bytes} bytes`;
  return (
    <div className="mt-2">
      {/* An overwrite must not read like a new file: say what it replaces.
          `undefined` is a record saved before the backend reported it. */}
      {typeof existingBytes === "number" ? (
        <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
          <FileWarning className="h-3 w-3" />
          Replaces the existing file ({formatBytes(existingBytes)}) · new contents {size}
        </div>
      ) : (
        <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-foreground/45">
          <FilePlus className="h-3 w-3" />
          {existingBytes === null ? "New file" : "New contents"} · {size}
        </div>
      )}
      <pre className="max-h-72 overflow-auto rounded border border-foreground/10 bg-foreground/[0.04] px-2 py-1.5 font-mono text-[11px] leading-snug text-foreground/80 whitespace-pre-wrap break-words">
        <Revealed text={shown} />
        {clipped && (
          <span className="block pt-1 italic text-foreground/50">
            … preview cut at {MAX_PREVIEW_CHARS.toLocaleString()} characters; the whole file is
            written.{" "}
            <ShowAll onClick={() => setShowAll(true)} />
          </span>
        )}
      </pre>
    </div>
  );
}

function DiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const [showAll, setShowAll] = useState(false);
  const { rows, removed, added } = useMemo(() => {
    const all = diffLines(oldText, newText);
    return {
      rows: foldUnchanged(all),
      removed: all.filter((l) => l.kind === "del").length,
      added: all.filter((l) => l.kind === "add").length,
    };
  }, [oldText, newText]);
  const shown = showAll ? rows : rows.slice(0, MAX_DIFF_LINES);
  // Say what is past the cut, so "−700 +700" with only removals on screen
  // can't hide that the additions are further down.
  const rest = rows.slice(shown.length);
  const restRemoved = rest.filter((l) => l.kind === "del").length;
  const restAdded = rest.filter((l) => l.kind === "add").length;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-foreground/45">
        <Pencil className="h-3 w-3" />
        Change ·{" "}
        <span className="text-red-600 dark:text-red-300">−{removed}</span>{" "}
        <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      </div>
      <pre className="max-h-72 overflow-auto rounded border border-foreground/10 bg-foreground/[0.04] py-1 font-mono text-[11px] leading-snug text-foreground/80">
        {shown.map((l, i) =>
          l.kind === "fold" ? (
            <div key={i} className="select-none px-2 italic text-foreground/45">
              ⋯ {l.count} unchanged {l.count === 1 ? "line" : "lines"}
            </div>
          ) : (
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
              <Revealed text={l.text} />
              {l.noEol && (
                <span
                  className="ml-2 select-none italic text-foreground/50"
                  title="This text doesn't end with a line break, so whatever follows it in the file continues on this line."
                >
                  (no line break after this)
                </span>
              )}
            </div>
          ),
        )}
        {rest.length > 0 && (
          <div className="px-2 pt-1 italic text-foreground/50">
            … {rest.length} more {rest.length === 1 ? "row" : "rows"} ({restRemoved} removed,{" "}
            {restAdded} added).{" "}
            <ShowAll onClick={() => setShowAll(true)} />
          </div>
        )}
      </pre>
    </div>
  );
}

function ShowAll({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="not-italic font-medium text-foreground/75 underline underline-offset-2 hover:text-foreground"
    >
      Show all
    </button>
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
