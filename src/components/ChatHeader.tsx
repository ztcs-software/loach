import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Copy,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Sliders,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import {
  exportSession,
  ollamaListModels,
  ollamaProbe,
  openaiListModels,
} from "@/lib/tauri";
import { Layers } from "lucide-react";
import { parseImportContext, type ParsedImport } from "@/lib/importContext";
import type { ModelInfo, ProviderId, Session } from "@/types";

export function ChatHeader({ session }: { session: Session | undefined }) {
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const importMessages = useChatStore((s) => s.importMessages);
  // Single-chat actions piped through chatStore. We deliberately don't keep
  // local mirrors of these — the store re-renders ChatHeader's `session`
  // prop when state flips, so labels (Pin/Unpin, Move/Restore) stay
  // truthful without our help.
  const renameSession = useChatStore((s) => s.rename);
  const pinSession = useChatStore((s) => s.pin);
  const archiveSession = useChatStore((s) => s.archive);
  const removeSession = useChatStore((s) => s.remove);
  const toggleParams = useUIStore((s) => s.toggleParams);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const openSettingsTab = useUIStore((s) => s.openSettingsTab);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const settings = useSettingsStore();

  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [openaiModels, setOpenaiModels] = useState<ModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  /** Controlled open state for the model picker. Mostly self-driven, but the
   *  onboarding-finish path sets a `pendingOpenModelPicker` flag on uiStore so
   *  the first thing a freshly-onboarded user sees is the model dropdown
   *  already expanded. */
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const pendingOpenModelPicker = useUIStore((s) => s.pendingOpenModelPicker);
  const consumePendingOpenModelPicker = useUIStore(
    (s) => s.consumePendingOpenModelPicker,
  );
  useEffect(() => {
    if (!pendingOpenModelPicker) return;
    if (!session) return;
    consumePendingOpenModelPicker();
    setModelMenuOpen(true);
  }, [pendingOpenModelPicker, session, consumePendingOpenModelPicker]);

  /** Export-context dialog state. `text` is null while the Markdown is still
   *  being fetched from the Rust side so we can show a "Loading…" placeholder
   *  instead of an empty textarea. `error` surfaces any failure inline. */
  const [exportOpen, setExportOpen] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Marks the "Search in chat" path so we can skip Radix's
   *  `onCloseAutoFocus` for that one menu item. Without this, Radix
   *  restores keyboard focus to the trigger button after the menu closes,
   *  which steals focus from the search overlay's input that the
   *  ChatCanvas useEffect just placed there. Set right before dispatching
   *  the open event; consumed (and reset) by the auto-focus handler. */
  const skipMenuRefocus = useRef(false);

  /** Rename-chat dialog state. Local-only — committed to the store on Save
   *  so the user can back out of an in-progress edit by hitting Cancel /
   *  Esc without bumping the persisted title. */
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  /** Import-context dialog state. The textarea binds straight to `importText`;
   *  format detection runs on every keystroke via `parseImportContext` so the
   *  preview line below the textarea always reflects what an Import click
   *  would actually do. `importBusy` blocks the button while the per-message
   *  appendMessage round-trips are in flight. */
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importPreview: ParsedImport = useMemo(
    () => parseImportContext(importText),
    [importText],
  );

  // ChatCanvas listens for `loach:open-chat-search` and toggles its
  // top-bar finder overlay. Mirrors the global Cmd-K palette wiring —
  // event-driven so we don't need a ref or a shared store flag.
  //
  // Setting `skipMenuRefocus` before dispatch tells the DropdownMenu's
  // onCloseAutoFocus handler (below) to skip Radix's default behaviour of
  // returning focus to the trigger button. Without that flip, Radix
  // would steal the focus we're about to place on the search input.
  const openChatSearch = () => {
    if (!session) return;
    skipMenuRefocus.current = true;
    window.dispatchEvent(new CustomEvent("loach:open-chat-search"));
  };

  const togglePin = () => {
    if (!session) return;
    void pinSession(session.id, !session.pinned_at);
  };

  const startRename = () => {
    if (!session) return;
    setRenameDraft(session.title);
    setRenameOpen(true);
  };

  const commitRename = () => {
    if (!session) return;
    const next = renameDraft.trim();
    if (!next || next === session.title) {
      setRenameOpen(false);
      return;
    }
    void renameSession(session.id, next);
    setRenameOpen(false);
  };

  const toggleArchive = () => {
    if (!session) return;
    void archiveSession(session.id, session.archived_at == null);
  };

  const handleDelete = () => {
    if (!session) return;
    if (
      confirm(
        `Delete this chat (${session.title || "Untitled"})? This cannot be undone — all messages and metrics will be removed.`,
      )
    ) {
      void removeSession(session.id);
    }
  };

  const openExport = async () => {
    if (!session) return;
    setExportOpen(true);
    setExportText(null);
    setExportError(null);
    setCopied(false);
    try {
      const md = await exportSession(session.id, "md");
      setExportText(md);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  const openImport = () => {
    if (!session) return;
    setImportOpen(true);
    setImportText("");
    setImportError(null);
  };

  const doImport = async () => {
    if (!session) return;
    if (importPreview.messages.length === 0) {
      setImportError(
        "Nothing to import — paste an exported chat (JSON or Markdown) or any text to add as a user message.",
      );
      return;
    }
    setImportBusy(true);
    setImportError(null);
    try {
      await importMessages(session.id, importPreview.messages);
      setImportOpen(false);
      setImportText("");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  };

  const copyExport = async () => {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      // Snap back to the default "Copy" label after a short beat so the user
      // can copy again if needed without reopening the dialog.
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("clipboard write failed", e);
    }
  };

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const probe = await ollamaProbe(settings.ollama_base_url).catch(() => false);
        setOllamaUp(probe);
        if (probe) {
          const m = await ollamaListModels(settings.ollama_base_url).catch(() => []);
          setOllamaModels(m);
        } else {
          setOllamaModels([]);
        }
        if (settings.openai_key_set) {
          const m = await openaiListModels(settings.openai_base_url).catch(() => []);
          setOpenaiModels(m);
        }
      } finally {
        setLoading(false);
      }
    },
    [settings.ollama_base_url, settings.openai_base_url, settings.openai_key_set],
  );

  useEffect(() => {
    if (!settings.hydrated) return;
    refresh();
  }, [settings.hydrated, refresh]);

  const currentLabel = session
    ? `${session.model || "(no model)"} · ${session.provider}`
    : "Select a chat";

  const select = (provider: ProviderId, model: string) => {
    if (!session) return;
    setSessionModel(session.id, provider, model);
  };

  const spaceName = useSpaceStore((s) => {
    if (!session?.space_id) return null;
    return s.spaces.find((sp) => sp.id === session.space_id)?.name ?? null;
  });

  const navigateToSpace = () => {
    if (!session?.space_id) return;
    setSidebarTab("spaces");
    setViewingSpace(session.space_id);
  };

  return (
    <div className="flex h-12 items-center justify-between gap-3 border-b border-foreground/5 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {session?.archived_at != null && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-foreground/60">
            <Archive className="h-3 w-3" />
            Archived
          </span>
        )}
        {session ? (
          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            {spaceName && (
              <>
                <button
                  type="button"
                  onClick={navigateToSpace}
                  title={`Open space "${spaceName}"`}
                  className="flex min-w-0 max-w-[180px] shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{spaceName}</span>
                </button>
                <span className="shrink-0 text-foreground/30">/</span>
              </>
            )}
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/85">
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-foreground/55" />
              <span className="truncate">{session.title || "Untitled"}</span>
            </span>
          </div>
        ) : (
          <span className="text-sm text-foreground/60">Select a chat</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className={cn(
                "h-8 max-w-[280px] rounded-full border border-foreground/15 text-foreground/80 hover:border-foreground/25 hover:bg-foreground/10 hover:text-foreground",
              )}
            >
              <span className="truncate">{currentLabel}</span>
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[280px]">
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownMenuLabel className="p-0">Models</DropdownMenuLabel>
              <button
                className="rounded p-1 hover:bg-accent"
                onClick={(e) => {
                  e.preventDefault();
                  refresh();
                }}
                aria-label="Refresh models"
              >
                <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              </button>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5">
              {ollamaUp ? (
                <CircleCheck className="h-3 w-3 text-emerald-500" />
              ) : (
                <CircleAlert className="h-3 w-3 text-amber-500" />
              )}
              Ollama
            </DropdownMenuLabel>
            {ollamaModels.length === 0 && (
              <DropdownMenuItem disabled>
                {ollamaUp ? "No models installed" : "Not running"}
              </DropdownMenuItem>
            )}
            {ollamaModels.map((m) => (
              <DropdownMenuItem key={`ollama:${m.id}`} onSelect={() => select("ollama", m.id)}>
                {m.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>OpenAI</DropdownMenuLabel>
            {openaiModels.length === 0 && (
              <DropdownMenuItem disabled>
                {settings.openai_key_set ? "No models" : "API key not set"}
              </DropdownMenuItem>
            )}
            {openaiModels.slice(0, 30).map((m) => (
              <DropdownMenuItem key={`openai:${m.id}`} onSelect={() => select("openai", m.id)}>
                {m.label}
              </DropdownMenuItem>
            ))}
            {ollamaModels.length === 0 && !settings.openai_key_set && (
              <>
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[11px] text-foreground/55">
                  No models available. Configure one to get started:
                </div>
                <DropdownMenuItem onSelect={() => setSidebarTab("models")}>
                  Install local models…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openSettingsTab("providers")}>
                  Add an API key…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Chat actions"
              className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[200px]"
            // When the user picked "Search in chat", we want focus to land on
            // the search overlay's input — not be yanked back to the trigger
            // button by Radix's default close-focus behaviour. The ref is
            // single-use: consume it here, then reset so other items
            // (Pin / Rename / Delete) keep the standard "return focus to
            // trigger" UX a keyboard user expects.
            onCloseAutoFocus={(e) => {
              if (skipMenuRefocus.current) {
                e.preventDefault();
                skipMenuRefocus.current = false;
              }
            }}
          >
            <DropdownMenuItem onSelect={openChatSearch}>
              <Search className="mr-2 h-4 w-4" />
              Search in chat
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={togglePin}>
              {session?.pinned_at ? (
                <>
                  <PinOff className="mr-2 h-4 w-4" />
                  Unpin
                </>
              ) : (
                <>
                  <Pin className="mr-2 h-4 w-4" />
                  Pin this chat
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={startRename}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void openExport()}>
              <FileText className="mr-2 h-4 w-4" />
              Export context
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openImport()}>
              <ClipboardPaste className="mr-2 h-4 w-4" />
              Import context
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={toggleArchive}>
              {session?.archived_at != null ? (
                <>
                  <ArchiveRestore className="mr-2 h-4 w-4" />
                  Restore from archive
                </>
              ) : (
                <>
                  <Archive className="mr-2 h-4 w-4" />
                  Move to archive
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleParams}
          aria-label="Toggle parameters"
          className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          <Sliders className="h-4 w-4" />
        </Button>
      </div>

      {/* Rename dialog — small surface, single Input + Save/Cancel.
          Committing on Enter mirrors the sidebar's inline-rename UX so the
          two paths feel consistent. The dialog stays a dialog (not inline
          editing) because the chat title isn't displayed in the header
          itself — there's no obvious place to flip to an editor in-place. */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              The new title is saved to your local database; existing
              exports won't change retroactively.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2">
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setRenameOpen(false);
                }
              }}
              placeholder="Untitled"
              className="h-9 w-full rounded-md border border-foreground/10 bg-background/60 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/20"
            />
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              className="rounded-lg"
            >
              Cancel
            </Button>
            <Button
              onClick={commitRename}
              disabled={!renameDraft.trim()}
              className="rounded-lg"
            >
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import context</DialogTitle>
            <DialogDescription>
              Paste an exported chat context (JSON or Markdown) to bring its
              messages into this conversation, or paste any text to drop it in
              as a single user prompt. Imported messages append to the end of
              this chat.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2">
            <textarea
              autoFocus
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                if (importError) setImportError(null);
              }}
              placeholder={
                "Paste an exported chat or any text…\n\n" +
                "Examples we recognise:\n" +
                "  • JSON: { messages: [{ role: 'user', content: '…' }, …] }\n" +
                "  • Markdown: ## You / ## Assistant / ## System sections\n" +
                "  • Plain text: imported as one user message"
              }
              className="h-72 w-full resize-none rounded-md border border-foreground/10 bg-background/60 p-3 font-mono text-xs leading-relaxed text-foreground/85 focus:outline-none focus:ring-1 focus:ring-foreground/20"
            />
            <div className="mt-2 flex items-center justify-between text-[11px] text-foreground/55">
              <ImportFormatHint preview={importPreview} />
              {importError && (
                <span className="text-destructive">{importError}</span>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setImportOpen(false)}
              disabled={importBusy}
              className="rounded-lg"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void doImport()}
              disabled={
                importBusy || importPreview.messages.length === 0 || !session
              }
              className="rounded-lg"
            >
              {importBusy
                ? "Importing…"
                : importPreview.messages.length > 0
                  ? `Import ${importPreview.messages.length} message${importPreview.messages.length === 1 ? "" : "s"}`
                  : "Import"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export context</DialogTitle>
            <DialogDescription>
              The full chat context in Markdown. Copy it to share or reuse
              elsewhere.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2">
            {exportError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {exportError}
              </div>
            ) : exportText === null ? (
              <div className="flex h-64 items-center justify-center rounded-md border border-foreground/10 text-sm text-foreground/60">
                Loading…
              </div>
            ) : (
              <textarea
                readOnly
                value={exportText}
                className="h-64 w-full resize-none rounded-md border border-foreground/10 bg-background/60 p-3 font-mono text-xs leading-relaxed text-foreground/80 focus:outline-none focus:ring-1 focus:ring-foreground/20"
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setExportOpen(false)}
              className="rounded-lg"
            >
              Close
            </Button>
            <Button
              onClick={copyExport}
              disabled={!exportText}
              className="rounded-lg"
            >
              {copied ? (
                <>
                  <Check className="mr-2 h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One-line caption under the import textarea telling the user what format
 * the parser inferred. Stays out of the way when the textarea is empty so
 * a fresh dialog doesn't lead with "Empty — paste something".
 */
function ImportFormatHint({ preview }: { preview: ParsedImport }) {
  if (preview.format === "empty") {
    return <span className="opacity-60">Paste content above to begin.</span>;
  }
  const label =
    preview.format === "json"
      ? "JSON"
      : preview.format === "markdown"
        ? "Markdown"
        : "Plain text";
  const count = preview.messages.length;
  return (
    <span>
      Detected{" "}
      <span className="font-medium text-foreground/80">{label}</span>
      {" · "}
      {count} message{count === 1 ? "" : "s"} ready to import
    </span>
  );
}
