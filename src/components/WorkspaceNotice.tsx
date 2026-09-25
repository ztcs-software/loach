import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChipRemove } from "./ComposerChip";

/** "Working in <folder>" — the chat's workspace directory, shown as a line
 *  inside the composer above the textarea rather than as a chip beside the
 *  persona / tone ones: the folder scopes every future turn until it's
 *  removed, so it reads as where the chat is, not as a setting on it.
 *
 *  Only the folder's own name is shown; the whole path stays in the
 *  tooltip. */
export function WorkspaceNotice({
  root,
  toolsEnabled,
  instructions,
  locked,
  hidden,
  onOpen,
  onRemove,
}: {
  root: string;
  /** Settings → Tools → Workspace files. Picking a folder switches it on,
   *  but it can be turned off again afterwards — and then the notice would
   *  be promising tools the model doesn't have, so it says so instead. */
  toolsEnabled: boolean;
  /** The root's `LOACHFILE.md`, when it has one. A badge, with the file's
   *  first line in the tooltip, so it's visible that the model is being
   *  briefed by the project and not only by the user. */
  instructions: string | null;
  /** A reply is running in this chat. That turn resolved its folder when it
   *  started and keeps using it, so removing the folder now would only take
   *  effect afterwards — while the approval cards went on showing paths in
   *  a folder the notice no longer names. The ✕ waits for the turn to end. */
  locked: boolean;
  /** Files are being dragged over the composer; fades out with the textarea
   *  so the drop hint has the bar to itself. */
  hidden: boolean;
  /** Show the folder in the OS file manager. */
  onOpen: () => void;
  onRemove: () => void;
}) {
  const firstLine = instructions
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const instructionsHint = firstLine
    ? `\nProject instructions from LOACHFILE.md: ${
        firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
      }`
    : "";
  const hint =
    (toolsEnabled
      ? "The model can list, find, read and search this folder. Writes, edits, moves and deletions ask you first."
      : "Workspace file tools are switched off in Settings → Tools, so the model can't use this folder until they're turned back on.") +
    (locked ? "\nThe folder can't be changed or removed while a reply is running." : "");
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 pb-1 pl-2.5 text-xs text-foreground/55 transition-opacity",
        !toolsEnabled && "text-amber-700 dark:text-amber-300",
        hidden && "opacity-0",
      )}
      title={`Workspace: ${root}\n${hint}${instructionsHint}`}
    >
      <FolderOpen
        className={cn("h-3.5 w-3.5 shrink-0", toolsEnabled && "text-primary")}
      />
      <span className="min-w-0 truncate">
        Working in{" "}
        <button
          type="button"
          onClick={onOpen}
          title={`Open ${root}`}
          className={cn(
            "rounded-sm font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
            toolsEnabled && "text-foreground/85 hover:text-foreground",
          )}
        >
          {folderName(root)}
        </button>
      </span>
      {instructions && (
        <span className="shrink-0 text-[10px] tracking-wide opacity-80">LOACHFILE.md</span>
      )}
      {!toolsEnabled && (
        <span className="shrink-0 text-[10px] uppercase tracking-wider opacity-80">tools off</span>
      )}
      <ChipRemove label="Remove workspace directory" onClick={onRemove} disabled={locked} />
    </div>
  );
}

/** `C:\Users\me\code\loach` → `loach`. Splits on both separators so a
 *  Windows path reads the same way a POSIX one does, and falls back to the
 *  original string for anything it can't split (`/`). */
function folderName(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
}
