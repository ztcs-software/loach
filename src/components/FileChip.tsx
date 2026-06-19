import { File, FileText, Image as ImageIcon, X } from "lucide-react";
import { AttachmentActions } from "./AttachmentActions";
import type { Attachment } from "@/types";

function AttachmentIcon({ kind }: { kind: Attachment["kind"] }) {
  if (kind === "image") return <ImageIcon className="h-3.5 w-3.5 text-primary" />;
  if (kind === "text") return <FileText className="h-3.5 w-3.5 text-primary" />;
  return <File className="h-3.5 w-3.5 text-primary" />;
}

export function FileChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  return (
    <AttachmentActions
      attachment={attachment}
      className="gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs"
    >
      <AttachmentIcon kind={attachment.kind} />
      <span className="max-w-[140px] truncate">{attachment.name}</span>
      {attachment.truncated && (
        // Subdued amber pill — the document IS attached, the model WILL get
        // a leading slice of it, but the user should know what they uploaded
        // is larger than what reaches the model. Tooltip carries the detail.
        <span
          title="Document exceeded the per-attachment extraction limit; only a leading slice will be sent to the model."
          className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
        >
          truncated
        </span>
      )}
      <button
        type="button"
        // Stop propagation so clicking ✕ removes the chip without also
        // firing the wrapper's preview handler.
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        aria-label="Remove attachment"
      >
        <X className="h-3 w-3" />
      </button>
    </AttachmentActions>
  );
}
