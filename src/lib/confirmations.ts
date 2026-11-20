/** The confirmation for deleting a Space: its page and the Spaces grid each
 *  carried a copy. */
export function deleteSpaceConfirm(name: string) {
  return {
    title: `Delete Space “${name}”?`,
    body: "Its instructions, memories and uploaded files are deleted for good. Library sources stay in your Library, and its chats are kept outside any Space.",
    confirmLabel: "Delete Space",
    destructive: true,
  };
}

/**
 * The confirmation for deleting a chat. Six surfaces delete one — the sidebar,
 * the chat header, a Space's chat list, the archive, the keyboard shortcut and
 * `/delete` — and they had drifted into two wordings and two button labels.
 */
export function deleteChatConfirm(title: string) {
  return {
    title: "Delete this chat?",
    body: `“${title || "Untitled"}” and all its messages will be permanently deleted. This can't be undone.`,
    confirmLabel: "Delete chat",
    destructive: true,
  };
}
