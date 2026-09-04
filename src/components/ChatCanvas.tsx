import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronDown, ChevronUp, Hourglass, Import, Pin, Search, Sparkles, Trash2, Zap, X } from "lucide-react";
import { MessageItem } from "./Message";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { extractSummary } from "@/lib/contextUsage";
import { cn, prefersReducedMotion } from "@/lib/utils";
import { stripInlinedAttachments } from "@/lib/files";
import type { Message } from "@/types";

const EMPTY_MESSAGES: Message[] = [];

/** The text a message actually RENDERS. User bubbles strip the inlined
 *  attachment tail before display, so searching raw `content` produced
 *  matches with nothing on screen to highlight — the finder scrolled to the
 *  bubble and the DOM walker found no occurrence to mark. */
function displayedText(m: Message): string {
  return m.role === "user" ? stripInlinedAttachments(m.content) : m.content;
}

/** How many trailing render items mount when a chat opens. Older items reveal
 *  on demand via the "Show earlier messages" control. Opening a long chat used
 *  to mount (and markdown-parse + highlight) every message synchronously;
 *  windowing bounds that to the last screenful-plus. Counted in render items
 *  (a folded import batch is one item), which is what actually mounts. */
const WINDOW_SIZE = 50;

/** A transcript row to render: either a single normal message or a *hidden*
 *  imported batch (a run of rows sharing one `import_group`) folded into one
 *  collapsible card. Visible imports are NOT folded — they render as ordinary
 *  messages, exactly like a non-imported turn. */
type RenderItem =
  | { kind: "message"; message: Message; index: number }
  | {
      kind: "import";
      group: string;
      messages: Message[];
      /** Indices into the flat `messages` array — used to place the
       *  compaction divider relative to the card. */
      startIndex: number;
      endIndex: number;
    };

/** Walk the flat transcript and collapse only *hidden* imported batches into
 *  one import card; everything else (normal turns AND visible imports) passes
 *  through one-to-one so it renders as an ordinary message. Rows of a hidden
 *  batch are always contiguous (inserted together with stepped timestamps),
 *  so a single forward scan groups them. */
function buildRenderItems(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.import_group && m.import_hidden) {
      const group = m.import_group;
      const startIndex = i;
      const batch: Message[] = [];
      while (i < messages.length && messages[i].import_group === group) {
        batch.push(messages[i]);
        i++;
      }
      items.push({
        kind: "import",
        group,
        messages: batch,
        startIndex,
        endIndex: i - 1,
      });
    } else {
      items.push({ kind: "message", message: m, index: i });
      i++;
    }
  }
  return items;
}

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
  const removeImportGroup = useChatStore((s) => s.removeImportGroup);
  const { confirm } = useConfirm();

  // Visually-hidden polite live region: announce stream start/finish for the
  // active chat so screen-reader users know a reply is arriving / done without
  // narrating every token. Gated on session id so navigating away from a
  // still-streaming chat doesn't announce a misleading "complete".
  const [liveStatus, setLiveStatus] = useState("");
  const wasStreamingRef = useRef(false);
  const liveSessionRef = useRef(sessionId);
  useEffect(() => {
    if (liveSessionRef.current !== sessionId) {
      liveSessionRef.current = sessionId;
      wasStreamingRef.current = streamingHere;
      setLiveStatus("");
      return;
    }
    if (streamingHere && !wasStreamingRef.current) {
      setLiveStatus("Assistant is responding…");
    } else if (!streamingHere && wasStreamingRef.current) {
      setLiveStatus("Response complete.");
    }
    wasStreamingRef.current = streamingHere;
  }, [streamingHere, sessionId]);
  // Auto-summary text from the active session's system_prompt, if any.
  // Drives the "context was compacted here" divider that sits between
  // the rolled-up history and the still-active turns. Falls out as null
  // the moment the user deletes the marker block from the parameter
  // panel's "Custom instructions" textarea.
  const compactedSummary = useChatStore((s) =>
    s.activeSessionId
      ? extractSummary(
          s.sessions.find((x) => x.id === s.activeSessionId)?.system_prompt ??
            null,
        )
      : null,
  );

  // Index of the first message that is NOT compacted. The divider
  // renders right above this row, so the line visually separates "the
  // model can't see these anymore — only the summary" (above) from
  // "active context" (below). If every message is compacted (edge
  // case, shouldn't happen because compactContext keeps a 4-message
  // tail) we fall back to placing the divider at the very end.
  const firstActiveIndex = useMemo(() => {
    if (!compactedSummary) return -1;
    const i = messages.findIndex((m) => m.compacted_at == null);
    return i === -1 ? messages.length : i;
  }, [messages, compactedSummary]);

  // Collapse each run of messages sharing an `import_group` into one render
  // item so an imported batch shows as a single collapsible card instead of
  // a stream of fake turns. Normal messages pass through one-to-one.
  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

  // Responses the user pinned, in transcript order — the bar under the chat
  // header lists these. Kept in transcript order rather than pin order so
  // the bar reads the same way the conversation does.
  //
  // Hidden imported rows are excluded: they live inside a collapsed card and
  // only register a DOM ref while it's open, so their chip would scroll
  // nowhere. `Message` also withholds Pin on those rows, so this filter only
  // catches pins made before that gate existed.
  const pinned = useMemo(
    () => messages.filter((m) => m.pinned_at != null && !m.import_hidden),
    [messages],
  );

  const handleRemoveImport = async (group: string, count: number) => {
    if (!sessionId) return;
    const ok = await confirm({
      title: "Remove imported context?",
      body: `${count} imported message${count === 1 ? "" : "s"} will be removed from this chat. You can import them again later.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) void removeImportGroup(sessionId, group);
  };

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Mirror of the ref into React state — the scroll-to-bottom button needs
  // to re-render when this flips, which a ref alone can't trigger. Kept in
  // sync via the same scroll handler that updates `stickToBottom`.
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Transcript windowing (see WINDOW_SIZE). Only the last `visibleCount` render
  // items mount on open; `visibleCount` only ever GROWS within a session view
  // (so revealing older rows never re-collapses and jolts the scroll) and
  // resets on chat switch via the effect below. `prependAnchor` lets the layout
  // effect keep the viewport pinned when a reveal prepends rows above the fold.
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);

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
      .filter(
        (m) =>
          // Same exclusion the pinned bar makes: a hidden imported row only
          // registers a DOM ref while its collapsed card is open, so counting
          // it gave the user a match they could step onto but never see —
          // the counter advanced with no scroll and no highlight.
          !m.import_hidden && displayedText(m).toLowerCase().includes(q),
      )
      .map((m) => m.id);
  }, [messages, searchQuery]);

  useEffect(() => {
    setMatchCursor(0);
  }, [searchQuery, sessionId]);

  // Clamp when the result set SHRINKS under a stale cursor — an import batch
  // removed, `/clear`, a regenerate. The reset above only fires on a query or
  // chat change, so the counter could render "9/3" (and the scroll effect
  // silently no-op) until the next keypress re-modulo'd it.
  useEffect(() => {
    setMatchCursor((i) => (i < matchIds.length ? i : Math.max(0, matchIds.length - 1)));
  }, [matchIds.length]);

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
      el.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
      });
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

    // Never touch the streaming message's DOM. The highlighter mutates text
    // nodes via replaceChild; the streaming bubble re-renders every token, so
    // React would reconcile against our detached nodes — freezing the text or
    // throwing NotFoundError into the chat ErrorBoundary. Skip it in BOTH the
    // strip and highlight passes; it gets highlighted normally once it stops
    // streaming (this effect re-runs when `streamingHere` flips). The
    // streaming bubble is always the last message in the streaming session.
    const streamingMsgId =
      streamingHere && messages.length > 0
        ? messages[messages.length - 1].id
        : null;

    if (hasMarksRef.current) {
      // Strip stale highlights — covers query changes, search close, message
      // updates, and the case where a previously-matching message no longer
      // matches.
      for (const [id, el] of messageRefs.current.entries()) {
        if (id === streamingMsgId) continue;
        el
          .querySelectorAll<HTMLElement>("[data-loach-match]")
          .forEach(unwrapMark);
      }
      hasMarksRef.current = false;
    }
    if (!searchOpen) return;
    const q = searchQuery.trim();
    if (!q) return;
    const currentId = matchIds[matchCursor];
    // Drive the highlighting from `matchIds` rather than re-deriving it from
    // `messages`: the two filters have to agree, and they didn't. This loop
    // marked any message with a DOM ref whose displayed text matched, while
    // `matchIds` also excludes hidden imported rows — so expanding an import
    // card produced highlights the counter didn't count and prev/next could
    // never reach. Reusing the memoised list also drops a second full scan of
    // every message body per keystroke.
    for (const id of matchIds) {
      if (id === streamingMsgId) continue;
      const el = messageRefs.current.get(id);
      if (!el) continue;
      highlightTextNodes(el, q, id === currentId);
      hasMarksRef.current = true;
    }
  }, [searchOpen, searchQuery, matchIds, matchCursor, streamingHere]);

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

  // Reset the window when switching chats — the new transcript opens at its
  // own tail, not the depth the previous chat happened to be revealed to.
  //
  // Adjusted during render rather than in an effect. As an effect this ran a
  // commit LATE: the first render of the new chat still used the outgoing
  // chat's `visibleCount`, so switching away from a fully-expanded transcript
  // (search or a pin-jump pushes it to MAX, and it only ever grows) mounted
  // and markdown-parsed the entire new conversation for one frame before
  // throwing nearly all of it away — exactly the cost windowing exists to
  // avoid. React re-runs this render pass immediately with the new state and
  // discards the abandoned output; nothing below observes the stale value.
  const [windowedSessionId, setWindowedSessionId] = useState(sessionId);
  if (windowedSessionId !== sessionId) {
    setWindowedSessionId(sessionId);
    setVisibleCount(WINDOW_SIZE);
    // A chat opens at its tail. `stickToBottom` is otherwise only ever
    // written by the scroll handler, so without this the incoming chat
    // inherited whatever the outgoing one was left at: scroll up in chat A,
    // open chat B, and B rendered at A's pixel offset with the auto-stick
    // effect correctly declining to fix it. Setting the flag here hands the
    // work to that same effect, which runs on the `messages` change this
    // switch causes.
    stickToBottom.current = true;
  }

  // Searching needs every matching row mounted: jump-to-match and the inline
  // highlighter both reach messages through per-message DOM refs, which only
  // exist for mounted rows. Expand fully while the finder is open. The
  // expansion sticks (visibleCount only grows) so closing search never
  // re-collapses the list and yanks the scroll position.
  useEffect(() => {
    if (searchOpen) setVisibleCount(Number.MAX_SAFE_INTEGER);
  }, [searchOpen]);

  // After a reveal prepends older rows above the fold, shift scrollTop by the
  // height those rows added so the rows the user was reading stay put.
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (!anchor) return;
    prependAnchor.current = null;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [visibleCount]);

  const scrollToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    stickToBottom.current = true;
    setShowScrollButton(false);
  };

  // ---------------- Jump to a pinned response ----------------
  // Clicking a chip in the pinned bar scrolls its response into view and
  // flashes a highlight on it for a second. The row may sit above the
  // mounted window, so the click only records the target and expands the
  // window; the effect below does the scrolling once the row has mounted
  // and registered its ref.
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  const jumpToMessage = (id: string) => {
    // Only reach past the window when the target actually sits above it.
    // Expanding unconditionally would mount (and markdown-parse) the whole
    // transcript on every chip click — and because `visibleCount` only ever
    // grows, a single click on a chip pointing at a *visible* response would
    // permanently disable windowing for this chat.
    if (!messageRefs.current.has(id)) setVisibleCount(Number.MAX_SAFE_INTEGER);
    // Both updates batch into one render, so the effect below runs after any
    // revealed rows have committed their refs.
    setJumpTarget(id);
  };

  // Deliberately no cleanup function: clearing `jumpTarget` re-runs this
  // effect immediately, and a cleanup would cancel the highlight timer we
  // just started. The timer is torn down on unmount by the effect above.
  useEffect(() => {
    if (!jumpTarget) return;
    setJumpTarget(null);
    const el = messageRefs.current.get(jumpTarget);
    if (!el) return;
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    setHighlightId(jumpTarget);
    highlightTimer.current = window.setTimeout(
      () => setHighlightId(null),
      1000,
    );
  }, [jumpTarget]);

  // Same landing, different door: the Cmd/Ctrl-K palette parks a message id on
  // uiStore when the user picks a transcript hit, because at that moment the
  // chat is only just being selected and its messages may not have loaded yet.
  // Waiting for the row to appear in `messages` is what makes the handoff
  // reliable — `jumpToMessage` then takes over exactly as the pinned bar does,
  // including reaching past the mounted window for an old message.
  const pendingJumpMessageId = useUIStore((s) => s.pendingJumpMessageId);
  const consumePendingJumpMessage = useUIStore(
    (s) => s.consumePendingJumpMessage,
  );
  useEffect(() => {
    if (!pendingJumpMessageId) return;
    if (!messages.some((m) => m.id === pendingJumpMessageId)) return;
    consumePendingJumpMessage();
    jumpToMessage(pendingJumpMessageId);
  }, [pendingJumpMessageId, messages, consumePendingJumpMessage]);

  // Reveal the next batch of older rows. Snapshot the scroller geometry first
  // so the layout effect above can re-anchor once the prepended rows mount.
  const showEarlierMessages = () => {
    const el = scrollerRef.current;
    if (el) prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisibleCount((c) => c + WINDOW_SIZE);
  };

  // Unreachable in practice — App only mounts ChatCanvas once a session
  // exists AND has messages; the no-session states render `NoChatState` /
  // `ChatLoadingSkeleton` instead. Kept as a cheap guard rather than the
  // duplicate welcome screen that used to live here.
  if (!sessionId) return null;

  // Only the trailing window mounts. Items keep their original `index` /
  // `startIndex` (computed against the full `messages` array), so the
  // compaction-divider placement and `isLast` checks below stay correct on the
  // slice. `hiddenBefore` is how many messages sit above the window.
  const visibleItems =
    renderItems.length > visibleCount
      ? renderItems.slice(renderItems.length - visibleCount)
      : renderItems;
  const firstVisible = visibleItems[0];
  const hiddenBefore = firstVisible
    ? firstVisible.kind === "message"
      ? firstVisible.index
      : firstVisible.startIndex
    : 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Polite live region for stream lifecycle — visually hidden (3.4). */}
      <div aria-live="polite" className="sr-only">
        {liveStatus}
      </div>
      {pinned.length > 0 && (
        <PinnedBar pinned={pinned} onJump={jumpToMessage} />
      )}
      {/* Scroll area + its floating overlays. Positioned relative to THIS
          wrapper rather than the canvas root so the finder bar and the
          scroll-to-bottom pill sit inside the transcript area instead of
          on top of the pinned bar. */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollerRef} className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4">
            {hiddenBefore > 0 && (
              <div className="flex justify-center py-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={showEarlierMessages}
                  className="h-7 gap-1.5 rounded-full bg-foreground/[0.04] px-3 text-[11px] font-medium text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                  title="Reveal older messages in this chat"
                >
                  <ChevronUp className="h-3 w-3" />
                  Show earlier messages ({hiddenBefore})
                </Button>
              </div>
            )}
            {visibleItems.map((item) => {
              // The compaction divider sits before whichever render item holds
              // the first still-active (uncompacted) message. For an import
              // card that's a range check, since the card spans several rows.
              const markerHere =
                compactedSummary != null &&
                firstActiveIndex >= 0 &&
                (item.kind === "message"
                  ? item.index === firstActiveIndex
                  : firstActiveIndex >= item.startIndex &&
                    firstActiveIndex <= item.endIndex);
              const marker = markerHere ? (
                <CompactionMarker summary={compactedSummary!} />
              ) : null;

              if (item.kind === "import") {
                return (
                  <div key={`import-${item.group}`}>
                    {marker}
                    <ImportedContextGroup
                      messages={item.messages}
                      messageRefs={messageRefs}
                      onRemove={() =>
                        void handleRemoveImport(item.group, item.messages.length)
                      }
                    />
                  </div>
                );
              }

              const m = item.message;
              const isLast = item.index === messages.length - 1;
              return (
                <div
                  key={m.id}
                  // Callback ref → keeps `messageRefs` in sync as messages
                  // mount / unmount without leaking entries. The phrase
                  // highlighter walks each message's subtree and wraps
                  // matches in `<mark>` tags inside the rendered content,
                  // so search applies no bubble-level visual of its own —
                  // the inline highlight is its only signal. The row tint
                  // below belongs to the pinned-bar jump, which needs to
                  // point at a whole response rather than a phrase.
                  ref={(el) => {
                    if (el) messageRefs.current.set(m.id, el);
                    else messageRefs.current.delete(m.id);
                  }}
                  className={cn(
                    "rounded-3xl transition-[background-color,box-shadow] duration-300",
                    highlightId === m.id &&
                      "bg-primary/[0.09] ring-1 ring-primary/40",
                  )}
                >
                  {marker}
                  <MessageItem
                    message={m}
                    isStreaming={isLast && streamingHere && m.role === "assistant"}
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
            {/* Edge case: every message is compacted (no active tail).
                Show the marker at the very bottom so the user still sees
                "compaction happened here". */}
            {compactedSummary != null &&
              messages.length > 0 &&
              firstActiveIndex === messages.length && (
                <CompactionMarker summary={compactedSummary} />
              )}
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
    </div>
  );
}

/**
 * Flatten a response into a single line of plain prose for the pinned-bar
 * chip. Deliberately shallow — it drops fence markers, unwraps links to
 * their text, removes table rules, and strips the handful of inline
 * markdown characters (including table pipes) that read as noise at chip
 * size, then collapses whitespace. It is not a renderer: a code-only
 * response previews as its first line of code, which is the honest thing
 * to show.
 */
function pinPreview(content: string): string {
  return content
    .replace(/^```.*$/gm, "")
    // [text](url) / ![alt](url) → text. Keeps the label, drops the URL.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Table separator rows and thematic breaks — lines of only pipes,
    // colons, dashes and spaces — carry no preview-worthy text.
    .replace(/^[|\s:-]+$/gm, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bar of pinned responses, sitting directly under the chat header. Each pin
 * is collapsed to one truncated line; clicking it scrolls that response into
 * view and flashes a highlight on it. Unpinning happens from the response's
 * own ⋯ menu, so the chips stay a pure navigation surface.
 */
/** One chip. Memoised on the message object so the three-regex `pinPreview`
 *  doesn't re-run for every pin on every streaming flush — `messages` gets a
 *  new array identity per RAF flush, and only the streaming row's object
 *  actually changes, so non-streaming pins hit the memo. */
const PinnedChip = memo(function PinnedChipImpl({
  message,
  onJump,
}: {
  message: Message;
  onJump: (id: string) => void;
}) {
  const preview = useMemo(() => pinPreview(message.content), [message.content]);
  return (
    <button
      type="button"
      onClick={() => onJump(message.id)}
      // The chip is a one-line summary; the tooltip gives enough of the
      // response to tell two similar pins apart before clicking.
      title={preview.slice(0, 300)}
      className="block max-w-[240px] shrink-0 truncate rounded-full border border-foreground/10 bg-foreground/[0.05] px-2.5 py-0.5 text-[11.5px] text-foreground/70 transition-colors hover:border-foreground/20 hover:bg-foreground/10 hover:text-foreground"
    >
      {preview || "Response"}
    </button>
  );
});

function PinnedBar({
  pinned,
  onJump,
}: {
  pinned: Message[];
  onJump: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-foreground/5 bg-foreground/[0.04] px-4 py-1.5 backdrop-blur-xl">
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-foreground/45">
        <Pin className="h-3 w-3" />
        Pinned
      </span>
      <div className="scrollbar-hidden flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
        {pinned.map((m) => (
          <PinnedChip key={m.id} message={m} onJump={onJump} />
        ))}
      </div>
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

/**
 * Inline marker shown at the top of the transcript whenever the session
 * has a Loach auto-summary block in its system_prompt. The bar's
 * Compact button is what creates that block — this is its visual
 * counterpart in the chat surface so the user can SEE that earlier
 * turns were rolled up, and click to inspect the exact bullets the
 * model produced. The summary itself isn't editable from here on
 * purpose: editing it from inside the transcript would be a confusing
 * second source of truth alongside the parameter panel's "Custom
 * instructions" textarea, which is the canonical home for system-prompt
 * content.
 */
function CompactionMarker({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide summary" : "Show summary of compacted messages"}
        className="group flex w-full items-center gap-2 rounded-full px-2 py-1 text-[11px] text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/80"
      >
        <span
          aria-hidden
          className="h-px flex-1 bg-gradient-to-r from-transparent to-foreground/15"
        />
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-primary/70" />
          <span className="font-medium tracking-wide uppercase text-[10px]">
            Earlier messages compacted
          </span>
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
        <span
          aria-hidden
          className="h-px flex-1 bg-gradient-to-l from-transparent to-foreground/15"
        />
      </button>
      {open && (
        <div className="mt-2 rounded-2xl border border-foreground/[0.10] bg-foreground/[0.03] px-4 py-3 text-[12.5px] leading-relaxed text-foreground/75 backdrop-blur-md">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground/45">
            Summary stored in system prompt
          </div>
          {/* The summary is plain bullet text from the model — render as
              whitespace-preserved so the bullets keep their formatting
              without pulling in the full Markdown pipeline. */}
          <pre className="whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed">
            {summary}
          </pre>
        </div>
      )}
    </div>
  );
}

/** A *hidden* imported batch, folded into a single collapsible card so it
 *  stays out of the transcript flow. Starts collapsed — the header is then
 *  just an indicator that the content is in context; expanding reveals the
 *  messages. The batch still reaches the model. The Remove control deletes
 *  the whole batch as a unit. (Visible imports never reach this component —
 *  they render as ordinary messages.) */
function ImportedContextGroup({
  messages,
  messageRefs,
  onRemove,
}: {
  messages: Message[];
  messageRefs: { current: Map<string, HTMLDivElement> };
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = messages.length;
  return (
    <div className="py-4">
      <div className="flex items-center gap-2 text-[11px] text-foreground/55">
        <span
          aria-hidden
          className="h-px flex-1 bg-gradient-to-r from-transparent to-foreground/15"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Collapse imported context" : "Show imported context"}
          className="group inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/80"
        >
          <Import className="h-3 w-3 text-primary/70" />
          <span className="font-medium tracking-wide uppercase text-[10px]">
            Imported context · {count} message{count === 1 ? "" : "s"}
          </span>
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Remove imported context"
          className="inline-flex items-center rounded-full p-1.5 text-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
        <span
          aria-hidden
          className="h-px flex-1 bg-gradient-to-l from-transparent to-foreground/15"
        />
      </div>
      {open && (
        <div className="mt-2 rounded-2xl border border-foreground/[0.10] bg-foreground/[0.03] px-2 pb-1 backdrop-blur-md">
          <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-foreground/45">
            Hidden from the transcript — still sent to the model
          </div>
          {messages.map((m) => (
            <div
              key={m.id}
              ref={(el) => {
                if (el) messageRefs.current.set(m.id, el);
                else messageRefs.current.delete(m.id);
              }}
            >
              <MessageItem message={m} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
