import { useLayoutEffect, useRef, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileText,
  MoreHorizontal,
  User,
} from "lucide-react";
import { Markdown } from "./Markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Attachment, Message as ChatMessage, MessageMetrics } from "@/types";
import { cn } from "@/lib/utils";
import { stripInlinedAttachments } from "@/lib/files";

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

/**
 * User prompts are rendered verbatim with `whitespace-pre-wrap`, which means
 * a long paste (a stack trace, a dumped article, a multi-paragraph spec)
 * fills the whole bubble and pushes the assistant reply down past the fold.
 *
 * This wrapper clamps the prompt to ~10 lines and surfaces a "Show more"
 * toggle when it actually overflows. We measure post-render via a layout
 * effect (cheaper than counting newlines, also handles soft-wrapped lines
 * that exceed the bubble's max-width) and skip the toggle entirely for
 * short prompts so the UI stays quiet for the common case.
 */
function ExpandableUserText({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Compare the natural height (no clamp) against what the user would see
    // when clamped. If they differ, there's content to reveal. We measure
    // whatever's currently rendered and trust the clamp class to land us
    // back in the right spot — `scrollHeight` ignores the line-clamp visual
    // truncation but reflects the height the element WOULD take.
    setOverflowing(el.scrollHeight - el.clientHeight > 1);
  }, [content, expanded]);

  return (
    <div>
      <p
        ref={ref}
        className={cn(
          "whitespace-pre-wrap text-sm leading-relaxed",
          // `line-clamp-[10]` falls back gracefully when the content is
          // shorter than the limit (no visible clamp, no toggle rendered).
          !expanded && "line-clamp-[10]",
        )}
      >
        {content}
      </p>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-foreground/55 transition-colors hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3 w-3 rotate-180 transition-transform" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3 transition-transform" />
              Show more
            </>
          )}
        </button>
      )}
    </div>
  );
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Copy the raw assistant content — full markdown, untouched — so pasting
  // into a code editor keeps fences / tables / headings intact.
  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard may be unavailable in some sandboxed WebView contexts;
      // fail silently rather than surface a fatal error for a secondary action.
    }
  };

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
  // Attachment bodies are inlined into the stored user content for the model;
  // strip that tail when rendering so the user sees just their typed prompt.
  const displayContent = isUser ? stripInlinedAttachments(message.content) : message.content;

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
          displayContent.length > 0 && (
            <ExpandableUserText content={displayContent} />
          )
        ) : (
          <Markdown content={message.content} />
        )}
        {!isUser && message.content.length > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            {showMetrics && (
              <span className="text-[11px] font-mono text-muted-foreground">
                ⏱ {showMetrics.tokens_per_second.toFixed(1)} tok/s ·{" "}
                {showMetrics.tokens} tok ·{" "}
                {(showMetrics.elapsed_ms / 1000).toFixed(2)}s
              </span>
            )}
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Message actions"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-full text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground",
                    menuOpen && "bg-foreground/10 text-foreground",
                  )}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <MoreHorizontal className="h-4 w-4" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[140px]"
              >
                <DropdownMenuItem
                  onSelect={() => void copyContent()}
                  className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
                >
                  <Copy className="h-4 w-4 text-foreground/60" />
                  Copy
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
