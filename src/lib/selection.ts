/**
 * Selection-text utilities for chat bubbles.
 *
 * Two reasons we can't just use `window.getSelection().toString()` directly:
 *
 *  1. For *user prompts* the browser serializer walks the bubble's DOM and
 *     inserts a newline at every block boundary it crosses — the wrapper
 *     div, the hidden right-click trigger, the absolutely-positioned kebab.
 *     A user copying their own "Thanks for that." ends up with blank lines
 *     bracketing the text. We avoid this by reading the prompt's text node
 *     directly and slicing it with the selection's offsets.
 *
 *  2. For *assistant replies* the markdown structure matters (code fences,
 *     tables, lists) so the browser's serialization is actually what we
 *     want there; we leave that path alone.
 *
 * The user prompt is marked with `[data-prompt-text]` on its `<p>` and the
 * assistant body is marked with `[data-message-content]` on its wrapper.
 */

export type SelectionSource = "user-prompt" | "assistant" | "other";

export interface CleanSelection {
  text: string;
  source: SelectionSource;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

/**
 * Inspect the current selection and return a clean string plus a tag for
 * what we extracted from. Returns `null` if there is no usable selection.
 */
export function getCleanSelectionText(): CleanSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const startEl = elementOf(range.startContainer);
  const endEl = elementOf(range.endContainer);
  if (!startEl || !endEl) return null;

  // User prompt branch — both endpoints must sit inside the same
  // [data-prompt-text] node. The prompt's <p> contains a single text node,
  // so we slice that text directly with the range offsets to avoid the
  // block-boundary newlines the browser would otherwise insert.
  const startPrompt = startEl.closest("[data-prompt-text]");
  const endPrompt = endEl.closest("[data-prompt-text]");
  if (startPrompt && startPrompt === endPrompt) {
    const p = startPrompt as HTMLElement;
    const textNode = p.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      const fullText = textNode.nodeValue ?? "";
      const start =
        range.startContainer === textNode ? range.startOffset : 0;
      const end =
        range.endContainer === textNode ? range.endOffset : fullText.length;
      return { text: fullText.slice(start, end), source: "user-prompt" };
    }
  }

  // Assistant branch — both endpoints inside any [data-message-content]
  // (which the user-prompt branch above would have already handled).
  // Markdown structure matters here, so trust the browser's serialization.
  const startMsg = startEl.closest("[data-message-content]");
  const endMsg = endEl.closest("[data-message-content]");
  if (startMsg && endMsg) {
    return { text: sel.toString(), source: "assistant" };
  }

  return { text: sel.toString(), source: "other" };
}
