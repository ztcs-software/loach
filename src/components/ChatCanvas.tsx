import { useEffect, useRef, useState } from "react";
import { ArrowDown, Hourglass, Zap, X } from "lucide-react";
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
              <MessageItem
                key={m.id}
                message={m}
                isStreaming={isLast && isStreaming && m.role === "assistant"}
                metrics={streamingByMessage[m.id] ?? null}
              />
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
