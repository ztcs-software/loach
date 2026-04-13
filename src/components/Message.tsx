import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, File, FileText, Brain, User } from "lucide-react";
import { Markdown } from "./Markdown";
import type { Attachment, Message as ChatMessage, MessageMetrics } from "@/types";
import { cn } from "@/lib/utils";

interface MessageProps {
  message: ChatMessage;
  isStreaming?: boolean;
  metrics?: MessageMetrics | null;
}

function parseMetrics(json: string | null): MessageMetrics | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as MessageMetrics;
  } catch {
    return null;
  }
}

function parseAttachments(json: string | null): Attachment[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as Attachment[];
  } catch {
    return [];
  }
}

function ThinkingBlock({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/70 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Brain className="h-3.5 w-3.5" />
        <span>{isStreaming && !open ? "Thinking…" : "Thinking"}</span>
      </button>
      {open && (
        <div className="mt-1.5 ml-5 rounded-lg border border-foreground/[0.06] bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

export function MessageItem({ message, isStreaming, metrics }: MessageProps) {
  if (message.role === "system") {
    return (
      <div className="mx-auto my-3 max-w-2xl rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground">
        {message.content}
      </div>
    );
  }

  const isUser = message.role === "user";
  const persistedMetrics = parseMetrics(message.metrics_json);
  const showMetrics = metrics ?? persistedMetrics;
  const attachments = isUser ? parseAttachments(message.attachments_json) : [];
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind === "text" || a.kind === "file");

  return (
    <div
      className={cn(
        "group flex gap-3 py-4",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl border border-foreground/10 bg-foreground/[0.06] backdrop-blur-md">
          <Bot className="h-4 w-4 text-orange-300" />
        </div>
      )}
      <div
        className={cn(
          "min-w-0 max-w-[78%]",
          isUser
            ? "rounded-3xl rounded-tr-lg border border-foreground/10 bg-foreground/[0.08] px-4 py-2.5 text-foreground backdrop-blur-xl"
            : "rounded-3xl rounded-tl-lg text-foreground/95",
        )}
      >
        {isUser && images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mime};base64,${img.data}`}
                alt={img.name}
                className="h-20 w-20 rounded-lg object-cover"
              />
            ))}
          </div>
        )}
        {isUser && files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.05] px-2.5 py-1 text-xs text-foreground/70"
              >
                {f.kind === "text" ? (
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0" />
                )}
                {f.name}
              </span>
            ))}
          </div>
        )}
        {!isUser && message.thinking && (
          <ThinkingBlock
            text={message.thinking}
            isStreaming={isStreaming && message.content.length === 0}
          />
        )}
        {message.content.length === 0 && isStreaming && !message.thinking ? (
          <div className="flex items-center gap-1.5 py-1 text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-current" />
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-current [animation-delay:200ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-current [animation-delay:400ms]" />
          </div>
        ) : isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
        ) : (
          <Markdown content={message.content} />
        )}
        {!isUser && showMetrics && (
          <div className="mt-1.5 text-[11px] font-mono text-muted-foreground">
            ⏱ {showMetrics.tokens_per_second.toFixed(1)} tok/s ·{" "}
            {showMetrics.tokens} tok ·{" "}
            {(showMetrics.elapsed_ms / 1000).toFixed(2)}s
          </div>
        )}
      </div>
      {isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl border border-foreground/10 bg-foreground/[0.06] backdrop-blur-md">
          <User className="h-4 w-4 text-foreground/80" />
        </div>
      )}
    </div>
  );
}
