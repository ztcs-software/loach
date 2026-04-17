import { useEffect, useRef, useState } from "react";
import { Paperclip, ArrowUp, FileUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileChip } from "./FileChip";
import {
  fileToAttachment,
  FileTooLargeError,
} from "@/lib/files";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/types";

interface ChatInputProps {
  centered?: boolean;
}

export function ChatInput({ centered = false }: ChatInputProps) {
  // "Streaming in this chat" means the global runner is currently producing
  // tokens for the active session. "Waiting in this chat" means this chat
  // has a task parked in the cross-chat queue. Either state counts as "busy"
  // for the purposes of disabling the send button — one in-flight prompt per
  // chat, period.
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streamingSessionId = useChatStore((s) => s.streamingSessionId);
  const waitingHere = useChatStore((s) =>
    !!activeSessionId &&
    s.queue.some((t) => t.sessionId === activeSessionId),
  );
  const streamingThisChat =
    !!activeSessionId && streamingSessionId === activeSessionId;
  const thisChatBusy = streamingThisChat || waitingHere;
  const send = useChatStore((s) => s.sendUserMessage);
  const composerDraft = useUIStore((s) => s.composerDraft);
  const composerAttachments = useUIStore((s) => s.composerAttachments);
  const composerInsertSeq = useUIStore((s) => s.composerInsertSeq);
  const setComposerDraft = useUIStore((s) => s.setComposerDraft);

  const [text, setText] = useState(composerDraft);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // External insert (e.g. from suggestion chips or a Snippet "Run") bumps
  // the seq counter. Text always reseeds; attachments reseed only when the
  // primer supplied some (so plain suggestion-chip inserts don't wipe the
  // user's pending file picks).
  useEffect(() => {
    setText(composerDraft);
    if (composerAttachments.length > 0) {
      setAttachments(composerAttachments);
    }
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerInsertSeq]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Drag-and-drop on the whole window
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if ((e as DragEvent).clientX === 0 && (e as DragEvent).clientY === 0) {
        setDragging(false);
      }
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setDragging(false);
      await ingest(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  });

  const ingest = async (files: File[]) => {
    setError(null);
    const next: Attachment[] = [];
    for (const f of files) {
      try {
        next.push(await fileToAttachment(f));
      } catch (e) {
        if (e instanceof FileTooLargeError) {
          setError(`${e.name} is larger than 15 MB.`);
        } else {
          setError("Failed to read file");
        }
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next]);
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await ingest(Array.from(e.target.files));
    e.target.value = "";
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Snapshot live store state so branching matches what sendUserMessage
    // will actually observe (the hook-bound selectors above could be a
    // render behind).
    const state = useChatStore.getState();
    const activeId = state.activeSessionId;
    const busyHere =
      !!activeId &&
      (state.streamingSessionId === activeId ||
        state.queue.some((t) => t.sessionId === activeId));

    // One-in-flight-per-chat cap: if this chat is already running or
    // already has a waiter, swallow the submit. The send button is disabled
    // in this state too — this is belt-and-suspenders.
    if (busyHere) return;

    setText("");
    setComposerDraft("");
    const toSend = attachments;
    setAttachments([]);
    setError(null);

    try {
      // sendUserMessage decides internally whether to start immediately or
      // park in the global queue. If another chat is currently streaming,
      // this call will enqueue rather than run — the waiting banner in the
      // canvas tells the user that happened.
      await send(trimmed, toSend);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  // Placeholder / disabled-title tracks the three states the user can be in:
  // busy-running, busy-waiting, or idle.
  let placeholder = "Ask anything…";
  let disabledTitle: string | null = null;
  if (streamingThisChat) {
    placeholder = "This chat is replying — stop it to send another…";
    disabledTitle =
      "Only one prompt per chat is accepted while it's replying. Stop the reply to send again.";
  } else if (waitingHere) {
    placeholder = "This chat is waiting in the queue…";
    disabledTitle =
      "This chat already has a prompt waiting. Cancel it or wait for it to run before sending another.";
  }

  return (
    <div
      className={cn(
        "relative px-4",
        centered ? "py-0" : "pb-5 pt-3",
      )}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-3xl border-2 border-dashed border-orange-300/60 bg-orange-400/10 text-sm text-orange-100 backdrop-blur-md">
          <FileUp className="mr-2 h-4 w-4" /> Drop files to attach
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl">
        {/* Small "Stop generating" pill above the composer, shown only when
            THIS chat is the one currently streaming. The waiting-banner in
            the canvas handles its own Cancel, so the pill isn't needed for
            the waiting state. */}
        <StopPill />

        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <FileChip
                key={`${a.name}-${i}`}
                attachment={a}
                onRemove={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        )}
        <div className="glass-prompt flex items-end gap-2 rounded-[28px] px-4 py-3 transition-all">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
            className="rounded-full text-foreground/65 hover:bg-foreground/10 hover:text-foreground"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
            className="hidden"
            onChange={onPick}
          />
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="min-h-[28px] max-h-[220px] flex-1 resize-none border-none bg-transparent backdrop-blur-none px-1 py-1.5 text-[15px] leading-relaxed text-foreground placeholder:text-foreground/40 shadow-none ring-0 outline-none focus-visible:ring-0 focus-visible:border-none focus-visible:outline-none focus-visible:bg-transparent rounded-none scrollbar-hidden"
            rows={1}
          />
          <Button
            type="button"
            size="icon"
            onClick={submit}
            disabled={
              (!text.trim() && attachments.length === 0) || thisChatBusy
            }
            aria-label={thisChatBusy ? "This chat is busy" : "Send"}
            title={disabledTitle ?? "Send"}
            className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-br from-orange-500 to-rose-600 text-white shadow-[0_6px_24px_-4px_rgba(255,90,40,0.75)] transition-all hover:from-orange-400 hover:to-rose-500 hover:shadow-[0_8px_28px_-4px_rgba(255,90,40,0.90)] disabled:from-orange-500/70 disabled:to-rose-600/70 disabled:text-white/85 disabled:shadow-[0_4px_18px_-6px_rgba(255,90,40,0.45)] disabled:cursor-not-allowed"
          >
            <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
          </Button>
        </div>
        {error && (
          <p className="mt-2 text-xs text-rose-300">{error}</p>
        )}
        {!centered && (
          <p className="mt-2 text-center text-[10px] text-foreground/35">
            Loach runs locally. Files are kept on your machine.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * "Stop generating" pill shown above the composer — only in the chat whose
 * reply is currently being streamed. Viewing another chat while a sibling
 * chat streams does not show this. Cancelling here tears down the active
 * stream and immediately promotes the next waiter in the global queue.
 */
function StopPill() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streamingSessionId = useChatStore((s) => s.streamingSessionId);
  const streamingThisChat =
    !!activeSessionId && streamingSessionId === activeSessionId;
  const cancelForSession = useChatStore((s) => s.cancelForSession);

  if (!streamingThisChat || !activeSessionId) return null;

  return (
    <div className="mb-2 flex justify-center">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void cancelForSession(activeSessionId)}
        className="h-7 gap-1.5 rounded-full bg-foreground/[0.06] px-3 text-[11px] font-medium text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
      >
        <Square className="h-3 w-3 fill-current" />
        Stop generating
      </Button>
    </div>
  );
}
