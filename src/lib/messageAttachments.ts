import { messageAttachments } from "@/lib/tauri";
import type { Attachment, Message } from "@/types";

/** A message's `attachments_json` as a list; `[]` when absent or malformed.
 *  An attachment listed without its contents (`omitted`) gets `data: ""`, so
 *  it still matches the `Attachment` type. */
export function parseAttachments(json: string | null): Attachment[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as Attachment[];
    return list.map((a) => (a.omitted ? { ...a, data: a.data ?? "" } : a));
  } catch {
    return [];
  }
}

/** A message's attachments with their contents. A chat loaded from disk lists
 *  them without (see `listMessages`), so those are fetched for this message
 *  alone; a message sent or streamed this session already has them. */
export async function loadAttachments(
  message: Pick<Message, "id" | "session_id" | "attachments_json">,
): Promise<Attachment[]> {
  const listed = parseAttachments(message.attachments_json);
  if (!listed.some((a) => a.omitted)) return listed;
  return parseAttachments(await messageAttachments(message.session_id, message.id));
}
