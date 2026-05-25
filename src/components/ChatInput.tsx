import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  FileUp,
  Mic,
  Plus,
  Scissors,
  Square,
  TextCursorInput,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileChip } from "./FileChip";
import { CommandPalette } from "./CommandPalette";
import { CommandResultPanel } from "./CommandResultPanel";
import { ContextUsageBar } from "./ContextUsageBar";
import {
  fileToAttachment,
  FileTooLargeError,
} from "@/lib/files";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { useToastStore } from "@/stores/toastStore";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PERSONA_ID,
  getPersona,
} from "@/lib/personas";
import { dispatch as dispatchCommand } from "@/lib/commands/dispatch";
import {
  isCommandInput,
  matchCommands,
  type PaletteEntry,
} from "@/lib/commands/parser";
import type { CommandResult } from "@/lib/commands/types";
import type { Attachment } from "@/types";

interface ChatInputProps {
  centered?: boolean;
}

export function ChatInput({ centered = false }: ChatInputProps) {
  // "Streaming in this chat" means the global runner is currently producing
  // tokens for the active session. "Waiting in this chat" means this chat
  // has a task parked in the cross-chat queue. Either state counts as "busy"
  // for the purposes of disabling the send button — one in-flight prompt per
  // chat, period. The streaming case additionally morphs the send button
  // into a stop button (see "Send/Stop morph" below).
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streamingSessionId = useChatStore((s) => s.streamingSessionId);
  const waitingHere = useChatStore((s) =>
    !!activeSessionId &&
    s.queue.some((t) => t.sessionId === activeSessionId),
  );
  const streamingThisChat =
    !!activeSessionId && streamingSessionId === activeSessionId;
  const send = useChatStore((s) => s.sendUserMessage);
  const cancelForSession = useChatStore((s) => s.cancelForSession);
  const composerDraft = useUIStore((s) => s.composerDraft);
  const composerAttachments = useUIStore((s) => s.composerAttachments);
  const composerInsertSeq = useUIStore((s) => s.composerInsertSeq);
  const setComposerDraft = useUIStore((s) => s.setComposerDraft);
  const personaIdBySession = useUIStore((s) => s.personaIdBySession);
  const pendingPersonaId = useUIStore((s) => s.pendingPersonaId);
  const setSessionPersona = useUIStore((s) => s.setSessionPersona);
  const setPendingPersona = useUIStore((s) => s.setPendingPersona);

  // Active persona resolves to whichever scope owns the picker right now:
  // an open chat reads from `personaIdBySession`; the welcome screen (no
  // session yet) falls back to `pendingPersonaId`, which chatStore.newSession
  // consumes when it materialises the session.
  const activePersonaId = activeSessionId
    ? personaIdBySession[activeSessionId]
    : pendingPersonaId;
  // The chip only renders for a *real* persona — "default" (None) is the
  // absence of a persona, not a thing to advertise above the composer.
  const activePersona =
    activePersonaId && activePersonaId !== DEFAULT_PERSONA_ID
      ? getPersona(activePersonaId)
      : null;

  const [text, setText] = useState(composerDraft);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; selStart: number; selEnd: number } | null
  >(null);
  // Slash-command palette state. `paletteDismissed` is sticky for the
  // current draft so Esc can hide the palette even while the user keeps
  // typing — it resets the next time the textarea clears or the leading
  // `/` disappears.
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const paletteEntries: PaletteEntry[] = useMemo(
    () => (isCommandInput(text) ? matchCommands(text.slice(1)) : []),
    [text],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const paletteOpen =
    !paletteDismissed && isCommandInput(text) && paletteEntries.length > 0;

  // Reset the Esc-dismissed flag when the user clears the textarea or
  // removes the leading slash — otherwise the palette would stay hidden
  // forever once the user has dismissed it once per session.
  useEffect(() => {
    if (!isCommandInput(text) && paletteDismissed) setPaletteDismissed(false);
  }, [text, paletteDismissed]);

  // Clamp the highlight when the entry list shrinks (e.g. the user typed
  // another character and only one suggestion remains).
  useEffect(() => {
    if (paletteIndex >= paletteEntries.length) {
      setPaletteIndex(Math.max(0, paletteEntries.length - 1));
    }
  }, [paletteEntries.length, paletteIndex]);

  const acceptPaletteEntry = (entry: PaletteEntry) => {
    setText(entry.insertText);
    setComposerDraft(entry.insertText);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const caret = entry.insertText.length;
      el.setSelectionRange(caret, caret);
    });
  };

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

  // Dismiss the right-click menu on any outside interaction. Bound globally
  // so a click elsewhere, a scroll, or pressing Escape closes it.
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = (e: MouseEvent) => {
      const el = ctxMenuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const onScroll = () => setCtxMenu(null);
    // Use mousedown so we close before a focus-stealing click lands.
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [ctxMenu]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // ------- Drag-and-drop from the OS file manager --------------------------
  //
  // Reliable enter/leave tracking needs a counter: browsers fire `dragenter`
  // on the new element AND `dragleave` on the old one each time the pointer
  // crosses a boundary, so a plain on/off flag flickers. We increment on
  // enter, decrement on leave, and only flip `dragging` when the counter
  // hits 0 or 1.
  //
  // Tauri requires `dragDropEnabled: false` in tauri.conf.json — otherwise
  // the native OS handler eats the drop before it reaches the webview and
  // these listeners never fire with real files.
  useEffect(() => {
    let depth = 0;

    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && e.dataTransfer.types.includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (depth === 1) setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Must preventDefault on dragover for the subsequent `drop` event to
      // fire. Setting the dropEffect here also changes the OS cursor to the
      // "copy" affordance.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (files && files.length) await ingest(Array.from(files));
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // Ctrl/Cmd+U bridge. The global shortcut handler dispatches this event;
  // ChatInput owns the file-input ref so we open the picker from here
  // instead of reaching across the tree for the DOM node.
  useEffect(() => {
    const openPicker = () => fileInputRef.current?.click();
    window.addEventListener("loach:open-file-picker", openPicker);
    return () =>
      window.removeEventListener("loach:open-file-picker", openPicker);
  }, []);

  const ingest = async (files: File[]) => {
    setError(null);
    const next: Attachment[] = [];
    for (const f of files) {
      try {
        next.push(await fileToAttachment(f));
      } catch (e) {
        if (e instanceof FileTooLargeError) {
          setError(`${e.name} is larger than 20 MB.`);
        } else {
          setError("Failed to read file");
        }
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next]);
  };

  // Apply a persona by id. The persona's text is layered into the system
  // prompt at send time (chatStore), so applying just records the picked id.
  // The textarea below the pickers stays untouched — it's the user's own
  // additional instructions, not the persona's. With a session, the id lives
  // on `personaIdBySession`; on the welcome screen it parks in
  // `pendingPersonaId` until newSession adopts it.
  const applyPersona = (personaId: string) => {
    if (!getPersona(personaId)) return;
    if (activeSessionId) {
      setSessionPersona(activeSessionId, personaId);
    } else {
      setPendingPersona(personaId === DEFAULT_PERSONA_ID ? null : personaId);
    }
  };

  const clearPersona = () => applyPersona(DEFAULT_PERSONA_ID);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await ingest(Array.from(e.target.files));
    e.target.value = "";
  };

  // ------- Clipboard paste ------------------------------------------------
  //
  // Mirrors the file picker / drag-and-drop paths, but driven by Ctrl+V on
  // the textarea. The clipboard exposes pasted files (screenshots from
  // Win+Shift+S, an image copied off a web page, real files copied from
  // Explorer) via two related but slightly different surfaces:
  //
  //   - `clipboardData.files` — modern, always a `FileList`. Used first.
  //   - `clipboardData.items` — older but still shipped; some sources only
  //     populate `items[]` with `kind === "file"`. We fall back to it when
  //     `files` is empty so we don't miss a screenshot in browsers that
  //     route it through the items[] path.
  //
  // If we found ANY files we call `preventDefault()` so the textarea
  // doesn't also receive a stray "[object File]" / filename string. If the
  // clipboard only has text we let React's default behaviour handle it.
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;

    const fromFiles = Array.from(dt.files ?? []);
    let picked: File[] = fromFiles;

    if (picked.length === 0 && dt.items && dt.items.length > 0) {
      const fileItems: File[] = [];
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) fileItems.push(f);
        }
      }
      picked = fileItems;
    }

    if (picked.length > 0) {
      e.preventDefault();
      await ingest(picked);
    }
    // No files? Let the default paste flow handle plain-text content.
  };

  // Triggered by the right-click "Paste" menu item. Reads plain text from the
  // OS clipboard and inserts it at the textarea's caret (replacing any current
  // selection), mirroring how Ctrl+V would behave for text. File paste stays
  // on Ctrl+V — the Clipboard API's `read()` for arbitrary file types is
  // permission-gated and inconsistent across WebView builds, so we keep this
  // entry point text-only and let the keyboard path handle the rest.
  //
  // The right-click menu captures the selection range at open time and passes
  // it back here, because by the time the menu item fires the textarea has
  // lost focus and its `selectionStart` has collapsed.
  const pasteFromClipboard = async (sel?: { start: number; end: number }) => {
    let clip = "";
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      setError("Clipboard access was blocked.");
      return;
    }
    if (!clip) return;
    const el = textareaRef.current;
    const start = sel?.start ?? el?.selectionStart ?? text.length;
    const end = sel?.end ?? el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + clip + text.slice(end);
    setText(next);
    setComposerDraft(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const caret = start + clip.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const cutSelection = async (sel: { start: number; end: number }) => {
    if (sel.start === sel.end) return;
    const slice = text.slice(sel.start, sel.end);
    try {
      await navigator.clipboard.writeText(slice);
    } catch {
      setError("Clipboard access was blocked.");
      return;
    }
    const next = text.slice(0, sel.start) + text.slice(sel.end);
    setText(next);
    setComposerDraft(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(sel.start, sel.start);
    });
  };

  const copySelection = async (sel: { start: number; end: number }) => {
    if (sel.start === sel.end) return;
    try {
      await navigator.clipboard.writeText(text.slice(sel.start, sel.end));
    } catch {
      setError("Clipboard access was blocked.");
    }
  };

  const selectAll = () => {
    const el = textareaRef.current;
    if (!el || text.length === 0) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(0, text.length);
    });
  };

  // ------- Voice dictation (Web Speech API) -------------------------------
  //
  // Available in Chromium / WebView2 (Windows) as `SpeechRecognition`,
  // and in older Chromium / Safari as `webkitSpeechRecognition`. Memoised
  // so feature-detection only runs once per mount, and so the mic button
  // is hidden entirely on platforms that don't ship the API (currently
  // most Linux WebKit builds — there's no stable polyfill that doesn't
  // ship audio off-device, which would violate Loach's offline-first
  // guarantee).
  const SR = useMemo(
    () =>
      typeof window !== "undefined"
        ? window.SpeechRecognition ?? window.webkitSpeechRecognition
        : undefined,
    [],
  );
  const speechSupported = !!SR;

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [listening, setListening] = useState(false);
  // Anchor the dictation against the text that was already in the box when
  // the user pressed the mic. Each interim result is rendered as
  // `baseText + interim`; each final result is committed back into
  // `baseText`. This way the user can keep typing between phrases without
  // having their typing clobbered by a mid-sentence interim update.
  const baseTextRef = useRef("");

  // Tear down recognition on unmount so we don't leave the mic hot.
  useEffect(
    () => () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* no-op */
      }
    },
    [],
  );

  const startDictation = () => {
    if (!SR || listening) return;
    setError(null);
    let recognition: SpeechRecognition;
    try {
      recognition = new SR();
    } catch {
      setError("Voice dictation isn't available on this device.");
      return;
    }
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    baseTextRef.current = text;

    const joinWithSpace = (a: string, b: string) =>
      a.length === 0 || /\s$/.test(a) || b.length === 0 ? a + b : `${a} ${b}`;

    recognition.onresult = (ev) => {
      let interim = "";
      let appendedFinal = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          appendedFinal += transcript;
        } else {
          interim += transcript;
        }
      }
      if (appendedFinal) {
        baseTextRef.current = joinWithSpace(baseTextRef.current, appendedFinal);
      }
      const next = interim
        ? joinWithSpace(baseTextRef.current, interim)
        : baseTextRef.current;
      setText(next);
      setComposerDraft(next);
    };

    recognition.onerror = (ev) => {
      // `not-allowed` fires when the user denies the mic permission, and
      // `service-not-allowed` when the underlying network speech service
      // is unreachable (Chromium routes through Google's hosted ASR when
      // available; WebView2 falls back to the on-device engine).
      const code = ev.error;
      if (code === "no-speech" || code === "aborted") {
        // Benign — happens when the user stops without saying anything.
      } else if (code === "not-allowed" || code === "service-not-allowed") {
        setError(
          "Microphone access was blocked. Allow it in your OS sound settings to dictate.",
        );
      } else {
        setError(`Dictation error: ${code}`);
      }
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
      // Keep focus in the textarea so the caret blinks where the words
      // will land — important affordance.
      textareaRef.current?.focus();
    } catch {
      setError("Couldn't start dictation. Try again.");
    }
  };

  const stopDictation = () => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* no-op */
    }
    setListening(false);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Slash-command path: parse + dispatch BEFORE the busy / send branches
    // so commands work even while another chat is streaming, and so they
    // don't get clobbered by the one-prompt-per-chat cap. Unknown commands
    // fall through to the normal send path so the user's literal text still
    // reaches the model (the "ignore unknown" rule).
    if (trimmed && isCommandInput(trimmed)) {
      const outcome = await dispatchCommand(trimmed);
      if (outcome.kind === "handled") {
        setText("");
        setComposerDraft("");
        setError(null);
        setPaletteDismissed(false);
        const result = outcome.result;
        if (result.kind === "toast") {
          useToastStore.getState().push({
            kind: result.tone === "error" ? "error" : "info",
            title: result.title,
            body: result.body,
          });
          setCommandResult(null);
        } else if (result.kind === "list") {
          setCommandResult(result);
        } else {
          setCommandResult(null);
        }
        return;
      }
      // Passthrough → fall through to send() with the literal text.
    }

    // Sending a real chat message clears any lingering command result so
    // it doesn't visually shadow the next assistant reply.
    setCommandResult(null);

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

    // Stop dictation before sending so the recogniser doesn't keep writing
    // into the now-empty textarea.
    if (listening) stopDictation();

    // Optimistic clear so the composer feels snappy. We snapshot what we're
    // sending so the catch branch can put it back — losing the user's draft
    // on a "No model selected" / network error is the worst kind of footgun.
    const sentText = trimmed;
    const sentAttachments = attachments;
    setText("");
    setComposerDraft("");
    setAttachments([]);
    setError(null);

    try {
      // sendUserMessage decides internally whether to start immediately or
      // park in the global queue. If another chat is currently streaming,
      // this call will enqueue rather than run — the waiting banner in the
      // canvas tells the user that happened.
      await send(sentText, sentAttachments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
      // Restore the draft only if the user hasn't started a new one in the
      // meantime — failures are typically synchronous ("no model selected")
      // so this branch usually wins, but we don't want to clobber fresh
      // typing if the send took long enough to lose to.
      setText((curr) => (curr === "" ? sentText : curr));
      if (useUIStore.getState().composerDraft === "") {
        setComposerDraft(sentText);
      }
      setAttachments((curr) => (curr.length === 0 ? sentAttachments : curr));
    }
  };

  // ------- Send/Stop morph -------------------------------------------------
  //
  // Single hit-target. The same circular button at bottom-right serves
  // three states:
  //
  //   - idle + has content → enabled "Send" (ArrowUp icon)
  //   - idle + empty       → disabled "Send"
  //   - this chat streaming → enabled "Stop" (square fill icon)
  //
  // The waiting-in-queue case still disables the button: that chat already
  // has a pending prompt, and the canvas's waiting banner exposes a
  // dedicated Cancel for the queued task.
  const onPrimaryClick = () => {
    if (streamingThisChat && activeSessionId) {
      void cancelForSession(activeSessionId);
      return;
    }
    void submit();
  };

  const primaryDisabled =
    !streamingThisChat &&
    ((!text.trim() && attachments.length === 0) || waitingHere);

  // Placeholder / disabled-title tracks the three states the user can be in:
  // busy-running, busy-waiting, or idle.
  let placeholder = "What's on your mind?";
  let disabledTitle: string | null = null;
  if (streamingThisChat) {
    placeholder = "Replying — press the Stop button to cancel and ask again…";
  } else if (waitingHere) {
    placeholder = "This chat is waiting in the queue…";
    disabledTitle =
      "This chat already has a prompt waiting. Cancel it or wait for it to run before sending another.";
  }

  const primaryAriaLabel = streamingThisChat
    ? "Stop generating"
    : "Send message";
  const primaryTitle = streamingThisChat
    ? "Stop generating"
    : (disabledTitle ?? "Send");

  return (
    <div
      className={cn(
        "relative px-4",
        centered ? "py-0" : "pb-5 pt-3",
      )}
    >
      <div className="relative mx-auto w-full max-w-3xl">
        {commandResult && commandResult.kind === "list" && (
          <CommandResultPanel
            result={commandResult}
            onDismiss={() => setCommandResult(null)}
          />
        )}
        {(attachments.length > 0 || activePersona) && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {activePersona && (
              <PersonaChip persona={activePersona} onRemove={clearPersona} />
            )}
            {attachments.map((a, i) => (
              <FileChip
                key={`${a.name}-${i}`}
                attachment={a}
                onRemove={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        )}
        {paletteOpen && (
          <CommandPalette
            entries={paletteEntries}
            highlightIndex={paletteIndex}
            onHighlightChange={setPaletteIndex}
            onSelect={acceptPaletteEntry}
          />
        )}
        <div
          className={cn(
            "glass-prompt relative flex items-end gap-2 rounded-[28px] px-4 py-3 transition-all",
            dragging && "drop-zone-target",
          )}
        >
          {/* Drag hint — rendered only while the user is dragging files.
              Sits over the textarea row with `pointer-events-none` so the
              window-level `drop` handler still sees the event. Colors are
              theme-aware: deep orange on light (contrasts white glass),
              pale orange on dark (contrasts dark glass). */}
          {dragging && (
            <div className="drop-zone-hint pointer-events-none absolute inset-0 flex items-center justify-center gap-2 rounded-[28px] text-sm font-semibold text-orange-700 dark:text-orange-100">
              <FileUp className="h-4 w-4" strokeWidth={2.25} />
              <span>Drop files here to attach</span>
            </div>
          )}

          {/* Composer "+" button — opens the OS file picker directly. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
            className="rounded-full text-foreground/65 hover:bg-foreground/10 hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
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
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // Palette navigation. Order matters: Tab/Enter accept the
              // highlighted entry into the textarea (no message send);
              // Enter without an open palette still sends, so unknown
              // commands fall through to submit() and the "ignore
              // unknown" rule kicks in inside there.
              if (paletteOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIndex((i) => (i + 1) % paletteEntries.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIndex(
                    (i) => (i - 1 + paletteEntries.length) % paletteEntries.length,
                  );
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const entry = paletteEntries[paletteIndex];
                  if (entry) acceptPaletteEntry(entry);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPaletteDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            onPaste={(e) => void onPaste(e)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const el = textareaRef.current;
              setCtxMenu({
                x: e.clientX,
                y: e.clientY,
                selStart: el?.selectionStart ?? 0,
                selEnd: el?.selectionEnd ?? 0,
              });
            }}
            placeholder={placeholder}
            className={cn(
              "min-h-[28px] max-h-[220px] flex-1 resize-none border-none bg-transparent backdrop-blur-none px-1 py-1.5 text-[15px] leading-relaxed text-foreground placeholder:text-foreground/40 shadow-none ring-0 outline-none focus-visible:ring-0 focus-visible:border-none focus-visible:outline-none focus-visible:bg-transparent rounded-none scrollbar-hidden transition-opacity",
              dragging && "opacity-0",
            )}
            rows={1}
          />

          {/* Voice dictation — hidden entirely when the platform doesn't
              expose the Web Speech API (most Linux WebKit builds). Sits
              immediately to the left of the primary send button so the
              two related actions (speak / send) are co-located on the
              right edge of the composer, mirroring the placement used by
              ChatGPT, Claude, and Gemini. When recording, the icon
              pulses and the button background tints rose to make the
              live state unmissable. */}
          {speechSupported && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={listening ? stopDictation : startDictation}
              aria-label={listening ? "Stop voice dictation" : "Start voice dictation"}
              aria-pressed={listening}
              title={listening ? "Stop dictation" : "Voice dictation"}
              className={cn(
                "relative rounded-full transition-colors",
                listening
                  ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 hover:text-rose-200"
                  : "text-foreground/65 hover:bg-foreground/10 hover:text-foreground",
              )}
            >
              <Mic
                className={cn(
                  "h-4 w-4 transition-transform",
                  listening && "animate-pulse",
                )}
              />
              {listening && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-rose-500/40 ring-offset-0 animate-pulse"
                />
              )}
            </Button>
          )}

          <PrimaryButton
            streaming={streamingThisChat}
            disabled={primaryDisabled}
            ariaLabel={primaryAriaLabel}
            title={primaryTitle}
            onClick={onPrimaryClick}
          />

        </div>
        {error && (
          <p className="mt-2 text-xs text-rose-300">{error}</p>
        )}
        {!centered && <ContextUsageBar />}
      </div>
      {ctxMenu && (
        <TextareaContextMenu
          ref={ctxMenuRef}
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasSelection={ctxMenu.selStart !== ctxMenu.selEnd}
          hasText={text.length > 0}
          onCut={() => {
            setCtxMenu(null);
            void cutSelection({ start: ctxMenu.selStart, end: ctxMenu.selEnd });
          }}
          onCopy={() => {
            setCtxMenu(null);
            void copySelection({ start: ctxMenu.selStart, end: ctxMenu.selEnd });
          }}
          onPaste={() => {
            setCtxMenu(null);
            void pasteFromClipboard({ start: ctxMenu.selStart, end: ctxMenu.selEnd });
          }}
          onSelectAll={() => {
            setCtxMenu(null);
            selectAll();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrimaryButton — Send/Stop morph
//
// One circular button. Two stacked icons cross-fade with a gentle
// scale + rotate so the swap reads as a *transform* rather than a flicker.
// While streaming, a soft halo pulses outside the button so the morphed
// state is visible at a glance even from across the canvas. Visual style
// stays on the same warm gradient — semantics are carried by the icon and
// the halo, not by a colour shift, which keeps the composer's colour
// language consistent.
// ---------------------------------------------------------------------------

interface PrimaryButtonProps {
  streaming: boolean;
  disabled: boolean;
  ariaLabel: string;
  title: string;
  onClick: () => void;
}

function PrimaryButton({
  streaming,
  disabled,
  ariaLabel,
  title,
  onClick,
}: PrimaryButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "relative h-10 w-10 shrink-0 rounded-full",
        // Send button picks up the theme accent via `--primary` / `--primary-glow`,
        // so it flips orange (Aurora) ↔ azure (Solid) automatically.
        "bg-primary text-primary-foreground",
        "shadow-[0_6px_24px_-4px_rgb(var(--primary-glow)/0.75)]",
        "transition-all duration-200",
        "hover:bg-primary/90 hover:shadow-[0_8px_28px_-4px_rgb(var(--primary-glow)/0.90)]",
        "disabled:bg-primary/70 disabled:text-primary-foreground/85",
        "disabled:shadow-[0_4px_18px_-6px_rgb(var(--primary-glow)/0.45)] disabled:cursor-not-allowed",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-0",
      )}
    >
      {/* Crossfading icon stack. Both icons live on top of each other in
          a fixed 20×20 grid cell; the transform-based fade keeps the
          centre stable so the morph reads as a single object changing
          shape, not two icons swapping places. */}
      <span className="relative grid h-5 w-5 place-items-center mx-auto">
        <ArrowUp
          aria-hidden
          strokeWidth={2.5}
          className={cn(
            "absolute h-5 w-5 transition-all duration-200 ease-out",
            streaming
              ? "scale-50 rotate-90 opacity-0"
              : "scale-100 rotate-0 opacity-100",
          )}
        />
        <Square
          aria-hidden
          className={cn(
            "absolute h-3 w-3 fill-current transition-all duration-200 ease-out",
            streaming
              ? "scale-100 rotate-0 opacity-100"
              : "scale-50 -rotate-90 opacity-0",
          )}
        />
      </span>

      {/* Streaming indicator — a calm 1 px breathing ring inside the
          button outline. The earlier `animate-ping` (radar pulse,
          175 % scale) read as too attention-grabbing for a "we're
          working in the background" cue once the stop icon was already
          visible. The icon swap carries the primary signal; this halo
          is the supporting hint. Pointer-events off so it never eats
          the click. */}
      {streaming && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/40 animate-pulse-soft"
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// PersonaChip — pill above the textarea showing the active persona, with an
// `×` to clear. Visually distinct from FileChip (warm orange tint vs. neutral
// glass) so the two stack types are unambiguous when both render at once.
// ---------------------------------------------------------------------------

function PersonaChip({
  persona,
  onRemove,
}: {
  persona: import("@/lib/personas").Persona;
  onRemove: () => void;
}) {
  const Icon = persona.icon;
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-orange-400/30 bg-orange-500/10 px-2.5 py-1 text-xs text-orange-200"
      title={persona.description}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium">{persona.label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${persona.label} persona`}
        className="ml-0.5 -mr-1 grid h-4 w-4 place-items-center rounded-full text-orange-200/70 hover:bg-orange-500/20 hover:text-orange-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TextareaContextMenu — Cut / Copy / Paste / Select All
//
// Cursor-positioned menu shown on right-click in the prompt textarea. Cut and
// Copy disable when there is no selection at the moment the menu opened (the
// caller snapshots the textarea's `selectionStart` / `selectionEnd` because
// opening the menu would otherwise blur the textarea and collapse the range).
// Paste stays enabled unconditionally — checking the clipboard requires an
// async `readText()` and a permission round-trip, so an enabled item that
// no-ops on empty clipboards is friendlier than a flicker of disabled state.
// ---------------------------------------------------------------------------

interface TextareaContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  hasText: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

const TextareaContextMenu = React.forwardRef<HTMLDivElement, TextareaContextMenuProps>(
  function TextareaContextMenu(
    { x, y, hasSelection, hasText, onCut, onCopy, onPaste, onSelectAll },
    ref,
  ) {
    // Render off-screen first, then measure and clamp/flip so the menu
    // never spills past the viewport edges (most commonly the bottom edge,
    // since the composer lives near the bottom of the window).
    const innerRef = useRef<HTMLDivElement>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    React.useLayoutEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      const { offsetWidth: w, offsetHeight: h } = el;
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
      if (top + h > vh - margin) top = Math.max(margin, y - h);
      setPos({ left, top });
    }, [x, y]);
    return (
      <div
        ref={innerRef}
        role="menu"
        style={
          pos
            ? { left: pos.left, top: pos.top }
            : { left: 0, top: 0, visibility: "hidden" }
        }
        className="fixed z-50 min-w-[200px] overflow-hidden rounded-md border border-foreground/10 bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl"
      >
        <CtxItem
          icon={<Scissors className="h-4 w-4" />}
          label="Cut"
          shortcut="Ctrl+X"
          disabled={!hasSelection}
          onSelect={onCut}
        />
        <CtxItem
          icon={<ClipboardCopy className="h-4 w-4" />}
          label="Copy"
          shortcut="Ctrl+C"
          disabled={!hasSelection}
          onSelect={onCopy}
        />
        <CtxItem
          icon={<ClipboardPaste className="h-4 w-4" />}
          label="Paste"
          shortcut="Ctrl+V"
          onSelect={onPaste}
        />
        <div className="my-1 h-px bg-foreground/10" />
        <CtxItem
          icon={<TextCursorInput className="h-4 w-4" />}
          label="Select All"
          shortcut="Ctrl+A"
          disabled={!hasText}
          onSelect={onSelectAll}
        />
      </div>
    );
  },
);

function CtxItem({
  icon,
  label,
  shortcut,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      // mousedown rather than click so the action runs before the global
      // dismiss listener (also bound to mousedown) tears the menu down.
      onMouseDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-sm transition-colors",
        disabled
          ? "cursor-default text-foreground/35"
          : "text-foreground/85 hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      <span className={cn("shrink-0", disabled ? "text-foreground/30" : "text-foreground/60")}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      <span className={cn("text-xs tabular-nums", disabled ? "text-foreground/30" : "text-foreground/45")}>
        {shortcut}
      </span>
    </button>
  );
}
