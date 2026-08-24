import { File, FileText, Image as ImageIcon } from "lucide-react";
import { AttachmentActions } from "./AttachmentActions";
import {
  ChipRemove,
  composerChipClass,
  composerChipIconClass,
} from "./ComposerChip";
import type { Attachment } from "@/types";

function AttachmentIcon({ kind }: { kind: Attachment["kind"] }) {
  const cls = composerChipIconClass("attachment");
  if (kind === "image") return <ImageIcon className={cls} />;
  if (kind === "text") return <FileText className={cls} />;
  return <File className={cls} />;
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
      className={composerChipClass("attachment")}
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
      <ChipRemove label={`Remove ${attachment.name}`} onClick={onRemove} />
    </AttachmentActions>
  );
}
