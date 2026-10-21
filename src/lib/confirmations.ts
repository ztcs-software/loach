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
