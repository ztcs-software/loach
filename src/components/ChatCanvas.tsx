import { useEffect, useRef } from "react";
import { MessageItem } from "./Message";
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

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distance < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

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
    <div ref={scrollerRef} className="flex-1 overflow-y-auto">
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
        <div className="h-4" />
      </div>
    </div>
  );
}
