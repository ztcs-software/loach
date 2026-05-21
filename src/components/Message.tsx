import { memo, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileText,
  Loader2,
  MoreHorizontal,
  Wrench,
} from "lucide-react";
import { Markdown } from "./Markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  Attachment,
  Message as ChatMessage,
  MessageMetrics,
  ToolCallRecord,
} from "@/types";
import { cn } from "@/lib/utils";
import { stripInlinedAttachments } from "@/lib/files";
import { Bookmark } from "lucide-react";
import { useSnippetStore } from "@/stores/snippetStore";

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

function parseToolCalls(json: string | null): ToolCallRecord[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ToolCallRecord[]) : [];
  } catch {
    return [];
  }
}

function ToolCallItem({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const pending = call.result === null;
  const failed = !pending && call.is_error;
  // Pretty-print arguments. The model sometimes ships a string instead of
  // an object — try to parse it for nicer display, fall back to raw.
  let argsText: string;
  if (typeof call.arguments === "string") {
    try {
      argsText = JSON.stringify(JSON.parse(call.arguments), null, 2);
    } catch {
      argsText = call.arguments;
    }
  } else {
    try {
      argsText = JSON.stringify(call.arguments, null, 2);
    } catch {
      argsText = String(call.arguments);
    }
  }
  // The qualified tool name comes through as `<serverSlug>__<toolName>` —
  // show the raw piece in the chip and the server in the header.
  const rawTool = call.tool.includes("__")
    ? call.tool.slice(call.tool.indexOf("__") + 2)
    : call.tool;
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs",
        failed
          ? "border-red-500/30 bg-red-500/5"
          : "border-foreground/10 bg-foreground/[0.03]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-foreground/70 transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground/55" />
        ) : failed ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0 text-foreground/55" />
        )}
        <span className="min-w-0 truncate font-mono">
          <span className="text-foreground/45">{call.server_name || "tool"} · </span>
          <span className="text-foreground/80">{rawTool}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-5">
          <div>
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wider text-foreground/40">
              Arguments
            </div>
            <pre className="max-h-40 overflow-auto rounded border border-foreground/10 bg-foreground/[0.04] px-2 py-1.5 font-mono text-[11px] leading-snug text-foreground/80 whitespace-pre-wrap break-words">
              {argsText || "{}"}
            </pre>
          </div>
          {!pending && (
            <div>
              <div className="mb-0.5 text-[10.5px] uppercase tracking-wider text-foreground/40">
                {failed ? "Error" : "Result"}
              </div>
              <pre
                className={cn(
                  "max-h-64 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words",
                  failed
                    ? "border-red-500/30 bg-red-500/[0.06] text-red-200"
                    : "border-foreground/10 bg-foreground/[0.04] text-foreground/80",
                )}
              >
                {call.result ?? ""}
              </pre>
            </div>
          )}
          {pending && (
            <div className="text-[11px] italic text-foreground/50">
              Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallsBlock({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <div className="mb-2 space-y-1.5">
      {calls.map((c) => (
        <ToolCallItem key={c.id} call={c} />
      ))}
    </div>
  );
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
        data-prompt-text
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

function MessageItemImpl({ message, isStreaming, metrics }: MessageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Separate state for the keyboard-accessible kebab below the user
  // bubble. Two menus (right-click + visible kebab) share the same
  // items but use distinct triggers so the right-click can still
  // anchor to the cursor while keyboard users get a discoverable
  // button. Without this second path, tabbing through messages
  // skipped right past the user's own Copy / Save-as-snippet
  // actions — a real a11y gap.
  const [userKebabOpen, setUserKebabOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Coordinates (relative to the bubble) where the user right-clicked. We pin
  // a hidden trigger to that point so the dropdown opens next to the cursor
  // instead of way down at the "..." button — a long assistant reply otherwise
  // makes the menu appear far from where the user clicked.
  const [assistantMenuOpen, setAssistantMenuOpen] = useState(false);
  const [assistantMenuPos, setAssistantMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [userMenuPos, setUserMenuPos] = useState<{ x: number; y: number } | null>(null);
  const openSnippetDialog = useSnippetStore((s) => s.openDialog);

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

  const copyUserContent = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // see copyContent above
    }
  };

  // Clipboard cleanup for user prompts (Ctrl+C, the floating "Copy" pill,
  // the right-click "Copy" item) is handled centrally via the
  // `getCleanSelectionText` helper + the document-level copy listener
  // installed in App. Per-bubble React onCopy doesn't fire reliably because
  // the native copy event targets `document.body` for non-editable text,
  // which is outside React's delegation root.

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
  const toolCalls = !isUser ? parseToolCalls(message.tool_calls_json) : [];
  const attachments = isUser ? parseAttachments(message.attachments_json) : [];
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind === "text" || a.kind === "file");
  // Attachment bodies are inlined into the stored user content for the model;
  // strip that tail when rendering so the user sees just their typed prompt.
  const displayContent = isUser ? stripInlinedAttachments(message.content) : message.content;

  return (
    <div
      className={cn(
        "group flex py-4",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "relative min-w-0 max-w-[88%]",
          isUser
            ? "rounded-3xl rounded-tr-lg border border-foreground/10 bg-foreground/[0.08] px-4 py-2.5 text-foreground backdrop-blur-xl"
            : "rounded-3xl rounded-tl-lg text-foreground/95",
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          const bubble = e.currentTarget.getBoundingClientRect();
          const pos = { x: e.clientX - bubble.left, y: e.clientY - bubble.top };
          if (isUser) {
            setUserMenuPos(pos);
            setUserMenuOpen(true);
          } else if (message.content.length > 0) {
            setAssistantMenuPos(pos);
            setAssistantMenuOpen(true);
          }
        }}
      >
        {isUser && (
          <DropdownMenu open={userMenuOpen} onOpenChange={setUserMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none absolute h-0 w-0 opacity-0"
                style={{
                  left: userMenuPos?.x ?? 0,
                  top: userMenuPos?.y ?? 0,
                }}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[180px]"
            >
              <DropdownMenuItem
                onSelect={() => void copyUserContent(displayContent)}
                className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
              >
                <Copy className="h-4 w-4 text-foreground/60" />
                Copy
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  openSnippetDialog({ seedPrompt: displayContent })
                }
                className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
              >
                <Bookmark className="h-4 w-4 text-foreground/60" />
                Save as Snippet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!isUser && message.content.length > 0 && (
          <DropdownMenu open={assistantMenuOpen} onOpenChange={setAssistantMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none absolute h-0 w-0 opacity-0"
                style={{
                  left: assistantMenuPos?.x ?? 0,
                  top: assistantMenuPos?.y ?? 0,
                }}
              />
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
        )}
        {isUser && images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mime};base64,${img.data}`}
                alt={img.name}
                // Fixed intrinsic size matches the rendered CSS box so the
                // browser doesn't have to wait on the decode to know the
                // layout. `loading="lazy"` + `decoding="async"` let chats
                // with lots of historical images defer their decode until
                // they scroll near the viewport — keeps the initial mount
                // snappy even on long transcripts.
                width={80}
                height={80}
                loading="lazy"
                decoding="async"
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
        {!isUser && toolCalls.length > 0 && (
          <ToolCallsBlock calls={toolCalls} />
        )}
        {message.content.length === 0 && isStreaming && !message.thinking && toolCalls.length === 0 ? (
          <div className="flex items-center gap-1.5 py-1 text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-current" />
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-current [animation-delay:200ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-current [animation-delay:400ms]" />
          </div>
        ) : isUser ? (
          displayContent.length > 0 && (
            <div data-message-content>
              <ExpandableUserText content={displayContent} />
            </div>
          )
        ) : (
          <div data-message-content>
            <Markdown content={message.content} />
          </div>
        )}
        {/* Keyboard-accessible action menu for user messages. Mirrors the
            assistant kebab below — same shape, same actions as the
            right-click menu above. Hidden until hover/focus to keep the
            outgoing-message look clean, but tab-reachable for keyboard
            users who couldn't otherwise open the hidden right-click
            trigger. */}
        {isUser && displayContent.length > 0 && (
          <div className="absolute -bottom-1 right-2 translate-y-full">
            <DropdownMenu open={userKebabOpen} onOpenChange={setUserKebabOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Message actions"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-full text-foreground/55 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    userKebabOpen
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[180px]"
              >
                <DropdownMenuItem
                  onSelect={() => void copyUserContent(displayContent)}
                  className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
                >
                  <Copy className="h-4 w-4 text-foreground/60" />
                  Copy
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    openSnippetDialog({ seedPrompt: displayContent })
                  }
                  className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
                >
                  <Bookmark className="h-4 w-4 text-foreground/60" />
                  Save as Snippet
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
    </div>
  );
}

// Stable identity for the message prop is guaranteed by chatStore: only the
// currently-streaming row gets a new object per token; all other rows keep
// their refs. Shallow ref equality therefore lets every non-streaming bubble
// skip re-render while tokens stream in.
export const MessageItem = memo(MessageItemImpl, (prev, next) =>
  prev.message === next.message &&
  prev.isStreaming === next.isStreaming &&
  prev.metrics === next.metrics,
);
