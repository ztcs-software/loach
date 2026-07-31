import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileText,
  GitFork,
  Loader2,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  TextSelect,
  Wrench,
} from "lucide-react";
import { AttachmentActions } from "./AttachmentActions";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { MarkdownSourceProvider } from "./markdownSource";
import { lastCodeBlock } from "@/lib/codeBlocks";
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
import { safeImageMime, stripInlinedAttachments } from "@/lib/files";
import { Bookmark } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useToastStore } from "@/stores/toastStore";

interface MessageProps {
  message: ChatMessage;
  isStreaming?: boolean;
  metrics?: MessageMetrics | null;
  /** True when this assistant message is eligible for one-click
   *  regeneration — it's the last message in the chat and the chat
   *  isn't currently busy. Drives whether the kebab menu surfaces
   *  the Regenerate item. */
  canRegenerate?: boolean;
}

/**
 * Return the current selection's text if it is entirely contained inside
 * `el`, otherwise empty. Used by the right-click handler to decide whether
 * to surface a "Copy selection" item — a selection that starts in another
 * bubble or in the sidebar shouldn't trigger this bubble's menu item.
 */
function getSelectionWithin(el: Element): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    return "";
  }
  return sel.toString();
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
        <span className="min-w-0 truncate font-mono text-foreground/80">
          {rawTool}
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
                    ? "border-red-500/30 bg-red-500/[0.06] text-red-700 dark:text-red-200"
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
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  const anyPending = calls.some((c) => c.result === null);
  const anyFailed = calls.some((c) => c.result !== null && c.is_error);

  const displayName = (tool: string) =>
    tool.includes("__") ? tool.slice(tool.indexOf("__") + 2) : tool;

  let label: string;
  if (anyPending) {
    label =
      calls.length === 1
        ? `Calling ${displayName(calls[0].tool)} tool…`
        : "Calling tools…";
  } else if (calls.length === 1) {
    label = `Called ${displayName(calls[0].tool)} tool`;
  } else {
    label = `Called ${calls.length} tools`;
  }

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
        {anyPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : anyFailed ? (
          <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
        ) : (
          <Wrench className="h-3.5 w-3.5" />
        )}
        <span>{label}</span>
      </button>
      {open && (
        <div className="mt-1.5 ml-5 space-y-1.5">
          {calls.map((c) => (
            <ToolCallItem key={c.id} call={c} />
          ))}
        </div>
      )}
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

function MessageItemImpl({ message, isStreaming, metrics, canRegenerate }: MessageProps) {
  const regenerateLast = useChatStore((s) => s.regenerateLast);
  const forkChat = useChatStore((s) => s.fork);
  const pinMessage = useChatStore((s) => s.pinMessage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Separate state for the keyboard-accessible kebab below the user
  // bubble. The kebab carries the full-content actions (Copy message,
  // Save as Snippet) that the right-click menu omits, so keyboard users
  // who can't open the cursor-anchored right-click menu still have a
  // discoverable, tab-reachable path to them.
  const [userKebabOpen, setUserKebabOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Coordinates (relative to the bubble) where the user right-clicked. We pin
  // a hidden trigger to that point so the dropdown opens next to the cursor
  // instead of way down at the "..." button — a long assistant reply otherwise
  // makes the menu appear far from where the user clicked.
  const [assistantMenuOpen, setAssistantMenuOpen] = useState(false);
  const [assistantMenuPos, setAssistantMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [userMenuPos, setUserMenuPos] = useState<{ x: number; y: number } | null>(null);
  // Selection text captured at the moment of right-click, scoped to this
  // bubble. Captured eagerly because opening the dropdown shifts focus and
  // can collapse the live selection before the menu item's handler runs.
  const [contextSelection, setContextSelection] = useState("");
  // Ref to the message body wrapper. Used by the right-click "Select all"
  // item to programmatically select the body text — and only the body, so
  // metrics and the "Show more" toggle stay outside the highlight.
  const bodyRef = useRef<HTMLDivElement>(null);
  const openSnippetDialog = useSnippetStore((s) => s.openDialog);

  // Single funnel for every clipboard write the message component does.
  // The Tauri webview can refuse `navigator.clipboard.writeText` in narrow
  // cases (focus loss mid-action, permission-policy edge cases on Linux,
  // remote-debugger contexts), and previously every caller swallowed the
  // failure silently — the user pressed Copy, nothing happened, no
  // feedback. Surface a one-shot error toast instead so the failure is at
  // least visible. Returns whether the write actually succeeded so callers
  // that toggle a "Copied" tick can skip the affirmative state on failure.
  const writeClipboard = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't copy",
        body: "Clipboard isn't available in this window.",
      });
      return false;
    }
  };

  // Copy the raw assistant content — full markdown, untouched — so pasting
  // into a code editor keeps fences / tables / headings intact.
  const copyContent = async () => {
    if (!(await writeClipboard(message.content))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const copyUserContent = async (text: string) => {
    await writeClipboard(text);
  };

  // Right-click "Copy" handler. Copies the bubble-scoped selection captured
  // at right-click time, or the full message body when nothing was selected.
  // Kept separate from `copyContent` so the kebab's "Copied" tick state isn't
  // affected by right-click copies.
  const copyFromContextMenu = async () => {
    const fullText =
      message.role === "user"
        ? stripInlinedAttachments(message.content)
        : message.content;
    const text = contextSelection || fullText;
    if (!text) return;
    await writeClipboard(text);
  };

  // Ctrl+C / Cmd+C copies the current selection, and the browser's serializer
  // adds a newline at every block boundary it crosses. The user bubble nests
  // the prompt inside several wrapper divs and sits next to a hidden
  // right-click trigger plus an absolutely-positioned kebab, so a full-bubble
  // selection ends up with blank lines bracketing the actual text.
  //
  // Intercept the copy event for the user bubble and write exactly the
  // selected slice of the prompt — backed by the original string in the DOM,
  // not the browser's selection serialization. The kebab's "Copy message"
  // and the right-click "Copy" already go through navigator.clipboard
  // directly and aren't affected by this handler; only the Ctrl+C / Cmd+C
  // path needs the interception. Falls through to the default behaviour when
  // the selection doesn't intersect the prompt or when the structure is
  // unexpected (multi-text-node) so we never make copy *worse* than today.
  const handleUserCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const bubble = e.currentTarget;
    if (
      !bubble.contains(range.startContainer) ||
      !bubble.contains(range.endContainer)
    )
      return;
    const p = bubble.querySelector<HTMLParagraphElement>("[data-prompt-text]");
    if (!p || !range.intersectsNode(p)) return;
    const textNode = p.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const fullText = textNode.nodeValue ?? "";
    const start =
      range.startContainer === textNode ? range.startOffset : 0;
    const end =
      range.endContainer === textNode ? range.endOffset : fullText.length;
    const text = fullText.slice(start, end);
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  };

  // Programmatically highlight the entire message body. Deferred to the next
  // frame because Radix's dropdown close-on-select would otherwise collapse
  // the new selection a beat after we set it.
  const selectAllBody = () => {
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };

  if (message.role === "system") {
    return (
      <div className="mx-auto my-3 max-w-2xl rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground">
        {message.content}
      </div>
    );
  }

  const isUser = message.role === "user";
  const isPinned = message.pinned_at != null;
  const togglePin = () =>
    void pinMessage(message.session_id, message.id, !isPinned);
  // Memoise the JSON parses on their source strings. chatStore only swaps these
  // strings when their dirty flags fire, so during a content-only streaming
  // flush they stay reference-equal and the parse is skipped — otherwise the
  // streaming bubble re-ran all three JSON.parse calls every animation frame.
  const persistedMetrics = useMemo(
    () => parseMetrics(message.metrics_json),
    [message.metrics_json],
  );
  const showMetrics = metrics ?? persistedMetrics;
  const toolCalls = useMemo(
    () => (!isUser ? parseToolCalls(message.tool_calls_json) : []),
    [isUser, message.tool_calls_json],
  );
  const attachments = useMemo(
    () => parseAttachments(message.attachments_json),
    [message.attachments_json],
  );
  // Images can come from a user upload or, on an assistant turn, from an
  // MCP tool result (mapped to an image attachment in mcp/client.rs).
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind === "text" || a.kind === "file");
  // Attachment bodies are inlined into the stored user content for the model;
  // strip that tail when rendering so the user sees just their typed prompt.
  const displayContent = isUser ? stripInlinedAttachments(message.content) : message.content;

  // Source binding for the Code Canvas. We only need the LAST fenced block's
  // raw text (the one that grows mid-stream) so "Open in canvas" can tell
  // whether the clicked block is the streaming tail. Extracted verbatim —
  // `CodeBlock`'s `raw` is verbatim too (the TeX fallback never touches code),
  // so the comparison still matches. Skipped entirely for user bubbles and
  // once streaming stops (there's nothing live to track then).
  const lastBlockRaw = useMemo(() => {
    if (isUser || !isStreaming) return null;
    return lastCodeBlock(message.content)?.code ?? null;
  }, [isUser, isStreaming, message.content]);

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
        onCopy={isUser ? handleUserCopy : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          const bubbleEl = e.currentTarget;
          const rect = bubbleEl.getBoundingClientRect();
          const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          setContextSelection(getSelectionWithin(bubbleEl));
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
          <DropdownMenu
            open={userMenuOpen}
            onOpenChange={(open) => {
              setUserMenuOpen(open);
              // Clear the snapshotted selection when the menu closes so a
              // later right-click that lands on the bubble without an
              // active selection doesn't copy the previous one.
              if (!open) setContextSelection("");
            }}
          >
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
              // Radix flips / shifts the menu automatically (`avoidCollisions`
              // is on by default) but only respects this padding when we
              // give it room — without `collisionPadding` a right-click
              // near the viewport edge can land the menu right against
              // the window chrome and clip the action icons.
              collisionPadding={8}
              className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[160px]"
            >
              <DropdownMenuItem
                onSelect={() => void copyFromContextMenu()}
                className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
              >
                <Copy className="h-4 w-4 text-foreground/60" />
                Copy
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={selectAllBody}
                className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
              >
                <TextSelect className="h-4 w-4 text-foreground/60" />
                Select all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!isUser && message.content.length > 0 && (
          <DropdownMenu
            open={assistantMenuOpen}
            onOpenChange={(open) => {
              setAssistantMenuOpen(open);
              if (!open) setContextSelection("");
            }}
          >
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
              collisionPadding={8}
              className="!bg-none !bg-foreground/[0.08] border border-foreground/10 backdrop-blur-xl min-w-[160px]"
            >
              <DropdownMenuItem
                onSelect={() => void copyFromContextMenu()}
                className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
              >
                <Copy className="h-4 w-4 text-foreground/60" />
                Copy
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={selectAllBody}
                className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
              >
                <TextSelect className="h-4 w-4 text-foreground/60" />
                Select all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {isUser && images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              // Thumbnail uses the same lazy-decode hints as before; click /
              // right-click routing now lives in AttachmentActions so the
              // image preview, the placeholder dialog, and the Code Canvas
              // path all share one dispatcher.
              <AttachmentActions
                key={`${img.name}-${i}`}
                attachment={img}
                className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <img
                  src={`data:${safeImageMime(img.mime)};base64,${img.data}`}
                  alt={img.name}
                  width={80}
                  height={80}
                  loading="lazy"
                  decoding="async"
                  className="h-20 w-20 rounded-lg object-cover"
                />
              </AttachmentActions>
            ))}
          </div>
        )}
        {isUser && files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <AttachmentActions
                key={`${f.name}-${i}`}
                attachment={f}
                className="gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.05] px-2.5 py-1 text-xs text-foreground/70"
              >
                {f.kind === "text" ? (
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0" />
                )}
                {f.name}
              </AttachmentActions>
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
            <div ref={bodyRef}>
              <ExpandableUserText content={displayContent} />
            </div>
          )
        ) : (
          <div ref={bodyRef}>
            <MarkdownSourceProvider
              value={{
                sessionId: message.session_id,
                messageId: message.id,
                streaming: !!isStreaming,
                lastBlockRaw,
              }}
            >
              {/* While streaming, only the trailing block re-parses per flush
                  (and skips highlighting) — completed blocks render once. Once
                  done, fall back to the plain whole-message render so the
                  settled view (and its full highlighting) is unchanged. */}
              {isStreaming ? (
                <StreamingMarkdown content={message.content} />
              ) : (
                <Markdown content={message.content} />
              )}
            </MarkdownSourceProvider>
          </div>
        )}
        {!isUser && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <AttachmentActions
                key={`${img.name}-${i}`}
                attachment={img}
                className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <img
                  src={`data:${safeImageMime(img.mime)};base64,${img.data}`}
                  alt={img.name}
                  width={80}
                  height={80}
                  loading="lazy"
                  decoding="async"
                  className="h-20 w-20 rounded-lg object-cover"
                />
              </AttachmentActions>
            ))}
          </div>
        )}
        {!isUser && files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <AttachmentActions
                key={`${f.name}-${i}`}
                attachment={f}
                className="gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.05] px-2.5 py-1 text-xs text-foreground/70"
              >
                {f.kind === "text" ? (
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0" />
                )}
                {f.name}
              </AttachmentActions>
            ))}
          </div>
        )}
        {/* Keyboard-accessible action menu for user messages — the
            full-content actions (Copy message, Save as Snippet) that the
            right-click menu intentionally omits. Hidden until hover/focus
            to keep the outgoing-message look clean, but tab-reachable so
            keyboard users have a discoverable path to these actions. */}
        {isUser && displayContent.length > 0 && (
          <div className="absolute -bottom-1 right-2 translate-y-full">
            <DropdownMenu open={userKebabOpen} onOpenChange={setUserKebabOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  // Tell screen-reader users what's behind the kebab —
                  // a generic "Message actions" reads the same for the
                  // user and assistant menus despite their action sets
                  // differing. This one carries Copy + Save as Snippet,
                  // which only make sense for the user's own message.
                  aria-label="Copy or save this message"
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
                  Copy message
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
            {isPinned && (
              <span
                title="Pinned — unpin from the ⋯ menu"
                className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10.5px] font-medium text-foreground/60"
              >
                <Pin className="h-3 w-3" />
                Pinned
              </span>
            )}
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
                  // Distinct label from the user kebab so screen-reader
                  // users know whose message is being acted on. Noun-led
                  // because the menu carries multiple actions (Copy,
                  // Regenerate when eligible).
                  aria-label="Assistant message actions"
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
                  Copy message
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={togglePin}
                  className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
                >
                  {isPinned ? (
                    <>
                      <PinOff className="h-4 w-4 text-foreground/60" />
                      Unpin this response
                    </>
                  ) : (
                    <>
                      <Pin className="h-4 w-4 text-foreground/60" />
                      Pin this response
                    </>
                  )}
                </DropdownMenuItem>
                {canRegenerate && (
                  <DropdownMenuItem
                    onSelect={() => void regenerateLast(message.session_id)}
                    className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
                  >
                    <RefreshCw className="h-4 w-4 text-foreground/60" />
                    Regenerate
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() =>
                    void forkChat(message.session_id, message.id)
                  }
                  className="gap-2.5 px-3 py-2 text-foreground/85 focus:text-foreground"
                >
                  <GitFork className="h-4 w-4 text-foreground/60" />
                  Fork from here
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
  prev.metrics === next.metrics &&
  prev.canRegenerate === next.canRegenerate,
);
