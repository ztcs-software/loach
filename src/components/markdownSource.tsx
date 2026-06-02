import { createContext, useContext } from "react";

/**
 * Identifies the chat message a `Markdown` block is rendering inside, so a
 * `CodeBlock`'s "Open in canvas" can bind the canvas to a live, still-
 * streaming code block instead of a dead snapshot.
 *
 * `lastBlockRaw` is the source text of the message's LAST fenced block (the
 * only one that grows mid-stream), pre-processed the same way `Markdown` pre-
 * processes its input so a `CodeBlock`'s `raw` compares apples-to-apples.
 * Null context (the default) means "not inside a streamed message" — e.g. the
 * snippet preview — and `CodeBlock` falls back to a static snapshot.
 */
export interface MarkdownSource {
  sessionId: string;
  messageId: string;
  streaming: boolean;
  lastBlockRaw: string | null;
}

const MarkdownSourceContext = createContext<MarkdownSource | null>(null);

export const MarkdownSourceProvider = MarkdownSourceContext.Provider;

export function useMarkdownSource(): MarkdownSource | null {
  return useContext(MarkdownSourceContext);
}
