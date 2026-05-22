import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronDown, ChevronUp, Hourglass, Search, Zap, X } from "lucide-react";
import { MessageItem } from "./Message";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chatStore";
import type { Message } from "@/types";

const EMPTY_MESSAGES: Message[] = [];

export function ChatCanvas() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const messages = useChatStore((s) =>
    s.activeSessionId
      ? s.messages[s.activeSessionId] ?? EMPTY_MESSAGES
      : EMPTY_MESSAGES,
  );
  const isStreaming = useChatStore((s) => s.isStreaming);
  // True only when THIS session is the one currently streaming, regardless
  // of whether some other chat is also running. Used to gate the
  // Regenerate menu item — a chat that happens to share the global runner
  // with a different session is still idle from the user's perspective.
  const streamingHere = useChatStore(
    (s) => !!s.activeSessionId && s.streamingSessionId === s.activeSessionId,
  );
  const streamingByMessage = useChatStore((s) => s.streamingByMessage);
  // A chat is "waiting" when it has a task parked in the global queue
  // (runningTask is a DIFFERENT session). We render a banner instead of
  // the assistant streaming dots so the user knows it's cross-chat gating,
  // not just a slow model.
  const waitingHere = useChatStore((s) =>
    !!s.activeSessionId &&
    s.queue.some((t) => t.sessionId === s.activeSessionId),
  );
  const promoteSession = useChatStore((s) => s.promoteSession);
  const cancelForSession = useChatStore((s) => s.cancelForSession);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Mirror of the ref into React state — the scroll-to-bottom button needs
  // to re-render when this flips, which a ref alone can't trigger. Kept in
  // sync via the same scroll handler that updates `stickToBottom`.
  const [showScrollButton, setShowScrollButton] = useState(false);

  // ---------------- Search-in-chat ----------------
  // A browser-style "find on page" overlay scoped to the current chat's
  // messages. Triggered by the chat header's "Search in chat" menu item via
  // the `loach:open-chat-search` custom event (mirrors the global Cmd-K
  // palette wiring). Esc closes; ↑/↓ navigates between matches.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Per-message DOM refs so we can scrollIntoView the current match without
  // computing offsets manually. Cleaned up via callback ref so removed
  // messages don't keep dangling entries in the map.
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Reset the cursor whenever the result set changes (typing, switching
  // chats, new incoming messages). Without this, a stale index could point
  // past the end of the array and the scroll/highlight would silently
  // do nothing.
  const matchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages
      .filter((m) => m.content.toLowerCase().includes(q))
      .map((m) => m.id);
  }, [messages, searchQuery]);

  useEffect(() => {
    setMatchCursor(0);
  }, [searchQuery, sessionId]);

  // Switching chats while the finder is open is jarring — the matches
  // belonged to the previous chat. Close the overlay so the user re-opens
  // it explicitly for the new context.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [sessionId]);

  useEffect(() => {
    const open = () => setSearchOpen(true);
    window.addEventListener("loach:open-chat-search", open);
    return () => window.removeEventListener("loach:open-chat-search", open);
  }, []);

  // Focus the input whenever the overlay opens. We can't just rely on the
  // input's `autoFocus` attribute or a setTimeout from the open handler:
  // Radix's DropdownMenu restores focus to its trigger button on close
  // (`onCloseAutoFocus`) AFTER `onSelect` runs, which steals the focus we
  // just placed on the input. Running this in a layout effect with a single
  // requestAnimationFrame defers the focus call past Radix's restoration —
  // React commit happens first, our RAF fires next, and we win the race.
  useEffect(() => {
    if (!searchOpen) return;
    const id = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [searchOpen]);

  // Scroll the active match into view whenever the cursor moves or the
  // matches list changes (e.g. new query). `scrollIntoView` handles the
  // `overflow-hidden` parent + smooth animation for us.
  useEffect(() => {
    if (!searchOpen) return;
    const id = matchIds[matchCursor];
    if (!id) return;
    const el = messageRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [matchCursor, matchIds, searchOpen]);

  // Inline phrase highlighting. The cleanest abstraction here would be a
  // custom rehype plugin running inside react-markdown so React owns the
  // highlight nodes — but we'd still need a separate path for plain-text
  // user messages. A single DOM walker covers both, at the cost of being
  // out-of-band of React's reconciliation: when messages re-render
  // (streaming, new turn) our marks get wiped from the DOM and we
  // re-apply on the next effect tick. The flicker is brief and only
  // happens during active streaming, which is acceptable.
  //
  // Tracks whether we currently have any marks in the DOM. The effect below
  // runs on every messages change (including every streaming token), so we
  // gate the unwrap pass on this flag — otherwise we'd run a
  // querySelectorAll for every message bubble per token even when the finder
  // is closed and there's nothing to strip.
  const hasMarksRef = useRef(false);
  useEffect(() => {
    // Fast path for the common case during streaming: search panel is
    // closed AND no marks were left in the DOM. Bail before doing any
    // DOM work so the effect's per-token re-runs are essentially free.
    // The slower path below still strips stale marks (e.g. search was
    // open then closed and we haven't run since) — gated behind
    // hasMarksRef so we never querySelectorAll across every message
    // bubble per token when there's nothing to find.
    if (!searchOpen && !hasMarksRef.current) return;

    if (hasMarksRef.current) {
      // Strip stale highlights — covers query changes, search close, message
      // updates, and the case where a previously-matching message no longer
      // matches.
      for (const el of messageRefs.current.values()) {
        el
          .querySelectorAll<HTMLElement>("[data-loach-match]")
          .forEach(unwrapMark);
      }
      hasMarksRef.current = false;
    }
    if (!searchOpen) return;
    const q = searchQuery.trim();
    if (!q) return;
    const lowerQ = q.toLowerCase();
    const currentId = matchIds[matchCursor];
    for (const m of messages) {
      if (!m.content.toLowerCase().includes(lowerQ)) continue;
      const el = messageRefs.current.get(m.id);
      if (!el) continue;
      highlightTextNodes(el, q, m.id === currentId);
      hasMarksRef.current = true;
    }
  }, [searchOpen, searchQuery, matchIds, matchCursor, messages]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setMatchCursor(0);
  };

  const stepMatch = (delta: 1 | -1) => {
    if (matchIds.length === 0) return;
    setMatchCursor((i) => {
      // Wrap around so power-users can go past either end without thinking.
      const next = (i + delta + matchIds.length) % matchIds.length;
      return next;
    });
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      stepMatch(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      stepMatch(-1);
    }
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distance < 80;
      // Only show the button when there's a meaningful chunk above the
      // fold; the same 200px threshold ChatGPT uses keeps tiny scroll
      // jitter (e.g. mid-token reflow) from flashing the chip on/off.
      setShowScrollButton(distance > 200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming, waitingHere]);

  const scrollToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottom.current = true;
    setShowScrollButton(false);
  };

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-center">
        <div>
          <p className="bg-gradient-to-br from-foreground via-foreground/90 to-orange-500/80 bg-clip-text text-3xl font-medium tracking-tight text-transparent">
            Welcome to Loach
          </p>
          <p className="mt-2 text-sm text-foreground/55">
            Create a new chat from the sidebar to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollerRef} className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            return (
              <div
                key={m.id}
                // Callback ref → keeps `messageRefs` in sync as messages
                // mount / unmount without leaking entries. The phrase
                // highlighter walks each message's subtree and wraps
                // matches in `<mark>` tags inside the rendered content,
                // so we don't apply any bubble-level visual ourselves —
                // the inline highlight is the only signal.
                ref={(el) => {
                  if (el) messageRefs.current.set(m.id, el);
                  else messageRefs.current.delete(m.id);
                }}
              >
                <MessageItem
                  message={m}
                  isStreaming={isLast && isStreaming && m.role === "assistant"}
                  metrics={streamingByMessage[m.id] ?? null}
                  canRegenerate={
                    isLast &&
                    m.role === "assistant" &&
                    !streamingHere &&
                    !waitingHere
                  }
                />
              </div>
            );
          })}
          {/* Banner shown only while THIS chat's task is parked behind another
              chat's running task. Replaces the assistant streaming-dots bubble
              (which would otherwise mislead the user into thinking the model
              is thinking). */}
          {waitingHere && sessionId && (
            <WaitingForOtherChats
              onRespondNow={() => void promoteSession(sessionId)}
              onCancel={() => void cancelForSession(sessionId)}
            />
          )}
          <div className="h-4" />
        </div>
      </div>

      {/* Search-in-chat finder bar. Top-right, browser-style. Only renders
          when the user opened it from the chat header menu — invisible by
          default so the canvas isn't cluttered with chrome the user didn't
          ask for. Match counter, prev/next, close — all in one row. */}
      {searchOpen && (
        <div className="absolute right-4 top-2 z-20">
          <div className="flex items-center gap-1 rounded-lg border border-foreground/[0.14] bg-popover/90 px-1.5 py-1 shadow-lg backdrop-blur-xl">
            <Search className="ml-1 h-3.5 w-3.5 shrink-0 text-foreground/45" aria-hidden />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Find in this chat…"
              spellCheck={false}
              className="h-7 w-56 min-w-0 bg-transparent px-1 text-[12.5px] text-foreground placeholder:text-foreground/40 focus:outline-none"
            />
            <span className="px-1 font-mono text-[10.5px] tabular-nums text-foreground/55">
              {matchIds.length === 0
                ? searchQuery.trim()
                  ? "0/0"
                  : ""
                : `${matchCursor + 1}/${matchIds.length}`}
            </span>
            <button
              type="button"
              onClick={() => stepMatch(-1)}
              disabled={matchIds.length === 0}
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => stepMatch(1)}
              disabled={matchIds.length === 0}
              aria-label="Next match"
              title="Next match (Enter)"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={closeSearch}
              aria-label="Close search"
              title="Close (Esc)"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Floating "scroll to bottom" pill. Shown only when the user has
          scrolled meaningfully up (~200px) — close to ChatGPT's behaviour.
          Pinned to the bottom-center so it stays out of the way of message
          actions on the right edge of bubbles. */}
      {showScrollButton && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-foreground/15 bg-background/90 text-foreground/70 backdrop-blur-md transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phrase highlighting helpers
// ---------------------------------------------------------------------------

/**
 * Replace `<mark data-loach-match>` with its children, then merge adjacent
 * text nodes so subsequent walks see the same shape they would have without
 * the previous highlight pass.
 */
function unwrapMark(mark: HTMLElement) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  // `normalize()` collapses split text nodes back into one, which keeps
  // future TreeWalker passes O(n) and stops a single text run from being
  // split across many sibling nodes after repeated highlight cycles.
  parent.normalize();
}

/**
 * Walk every text node under `root` and wrap occurrences of `query`
 * (case-insensitive) in `<mark>` elements. The current match gets a
 * stronger tint than the rest so the user can distinguish "where I am" vs
 * "the other matches still on screen".
 *
 * We deliberately don't recurse INTO existing marks (the "data-loach-match"
 * filter on the walker) — the unwrap pass before us already removed them,
 * but the guard keeps us safe if the function is called twice without
 * cleanup.
 */
function highlightTextNodes(
  root: Element,
  query: string,
  isCurrent: boolean,
) {
  if (!query) return;
  const lowerQ = query.toLowerCase();
  const len = query.length;

  // Snapshot text nodes first; mutating the tree while a TreeWalker is
  // iterating can skip nodes or revisit them. The filter rejects any text
  // that already lives inside a highlight wrapper.
  const targets: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node as Text).parentElement?.closest("[data-loach-match]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  for (const text of targets) {
    const value = text.nodeValue ?? "";
    const lower = value.toLowerCase();
    if (!lower.includes(lowerQ)) continue;

    const fragment = document.createDocumentFragment();
    let i = 0;
    while (i < value.length) {
      const idx = lower.indexOf(lowerQ, i);
      if (idx === -1) {
        if (i < value.length)
          fragment.appendChild(document.createTextNode(value.slice(i)));
        break;
      }
      if (idx > i)
        fragment.appendChild(document.createTextNode(value.slice(i, idx)));
      const mark = document.createElement("mark");
      mark.dataset.loachMatch = isCurrent ? "current" : "all";
      // Preserve the matched casing rather than echoing the query — yields
      // a natural-looking highlight ("JavaScript" stays "JavaScript" even
      // when the user typed "javascript").
      mark.textContent = value.slice(idx, idx + len);
      // Tailwind class strings — primary tint at two intensities. `text`
      // override keeps the wrapped run readable in case the parent
      // (e.g. an `hljs-comment` span) sets a low-contrast colour.
      mark.className = isCurrent
        ? "rounded-sm bg-primary/40 text-foreground"
        : "rounded-sm bg-primary/[0.18] text-foreground";
      fragment.appendChild(mark);
      i = idx + len;
    }
    text.parentNode?.replaceChild(fragment, text);
  }
}

/**
 * Shown on a chat whose prompt is waiting behind another chat's reply.
 * "Respond now" cancels the currently-running chat (in whichever session
 * that is) and promotes this chat to the front of the queue.
 */
function WaitingForOtherChats({
  onRespondNow,
  onCancel,
}: {
  onRespondNow: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.03] backdrop-blur-md">
          <Hourglass className="h-4 w-4 animate-pulse text-foreground/50" />
        </div>
        <div className="flex min-w-0 max-w-[78%] flex-col gap-2">
          <div className="rounded-3xl rounded-tl-lg border border-dashed border-foreground/15 bg-foreground/[0.04] px-4 py-2.5 text-sm text-foreground/70 backdrop-blur-xl">
            Waiting for other chats to finish…
          </div>
          <div className="flex items-center gap-2 pl-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRespondNow}
              className="h-7 gap-1.5 rounded-full bg-foreground/[0.06] px-3 text-[11px] font-medium text-foreground/75 hover:bg-foreground/10 hover:text-foreground"
              title="Interrupt the chat currently generating and jump this chat to the front of the queue"
            >
              <Zap className="h-3 w-3" />
              Respond now
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-7 gap-1.5 rounded-full px-3 text-[11px] font-medium text-foreground/55 hover:bg-foreground/10 hover:text-destructive"
              title="Drop this prompt from the queue"
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
