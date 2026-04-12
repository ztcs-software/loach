import { FileText, Image as ImageIcon, X } from "lucide-react";
import type { Attachment } from "@/types";

export function FileChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const isImage = attachment.kind === "image";
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs">
      {isImage ? (
        <ImageIcon className="h-3.5 w-3.5 text-primary" />
      ) : (
        <FileText className="h-3.5 w-3.5 text-primary" />
      )}
      <span className="max-w-[140px] truncate">{attachment.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        aria-label="Remove attachment"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
