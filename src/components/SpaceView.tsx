import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Layers,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSpaceStore } from "@/stores/spaceStore";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";
import { fileToAttachment } from "@/lib/files";
import { cn, relativeDay } from "@/lib/utils";
import { ChatInput } from "@/components/ChatInput";
import type { SpaceFile } from "@/types";

export function SpaceView() {
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const doUpdate = useSpaceStore((s) => s.updateSpace);
  const loadFiles = useSpaceStore((s) => s.loadSpaceFiles);
  const doAddFile = useSpaceStore((s) => s.addFile);
  const doRemoveFile = useSpaceStore((s) => s.removeFile);
  const storedFiles = useSpaceStore((s) =>
    viewingSpaceId ? s.spaceFiles[viewingSpaceId] : undefined,
  );

  const sessions = useChatStore((s) => s.sessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpacesList = useUIStore((s) => s.setViewingSpacesList);

  const space = spaces.find((s) => s.id === viewingSpaceId);

  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descVal, setDescVal] = useState("");
  const [instructions, setInstructions] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [files, setFiles] = useState<SpaceFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load space data
  useEffect(() => {
    if (space) {
      setNameVal(space.name);
      setDescVal(space.description);
      setInstructions(space.instructions);
      void loadFiles(space.id);
    }
  }, [space?.id]);

  useEffect(() => {
    if (storedFiles) setFiles(storedFiles);
  }, [storedFiles]);

  const spaceSessions = useMemo(
    () => sessions.filter((s) => s.space_id === viewingSpaceId),
    [sessions, viewingSpaceId],
  );

  if (!space) return null;

  const handleBack = () => {
    // "← All spaces" surfaces the full spaces browser rather than falling
    // back to the default chat view.
    setViewingSpace(null);
    setViewingSpacesList(true);
  };

  const handleSaveName = async () => {
    if (nameVal.trim() && nameVal !== space.name) {
      await doUpdate(space.id, nameVal.trim(), space.description, space.instructions);
    }
    setEditingName(false);
  };

  const handleSaveDesc = async () => {
    if (descVal !== space.description) {
      await doUpdate(space.id, space.name, descVal.trim(), space.instructions);
    }
    setEditingDesc(false);
  };

  const handleSaveInstructions = async () => {
    if (instructions !== space.instructions) {
      await doUpdate(space.id, space.name, space.description, instructions.trim());
    }
  };

  const handleAddFiles = async (fileList: FileList) => {
    setFileError(null);
    for (const file of Array.from(fileList)) {
      if (files.length >= 12) {
        setFileError("Maximum 12 files per space");
        break;
      }
      try {
        const att = await fileToAttachment(file);
        await doAddFile(space.id, att.name, att.mime, att.kind, att.data, file.size);
      } catch (e) {
        setFileError(String(e));
      }
    }
  };

  const handleRemoveFile = async (fileId: string) => {
    await doRemoveFile(fileId, space.id);
  };

  const handleStartChat = async () => {
    const session = await newSession();
    setViewingSpace(null);
    void selectSession(session.id);
  };

  const handleOpenChat = (sessionId: string) => {
    setViewingSpace(null);
    void selectSession(sessionId);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-8 py-6">
          {/* Back button */}
          <button
            onClick={handleBack}
            className="mb-6 flex items-center gap-1.5 text-sm text-foreground/50 hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            All spaces
          </button>

          {/* Space header */}
          <div className="mb-8">
            {editingName ? (
              <Input
                autoFocus
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onBlur={() => void handleSaveName()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setNameVal(space.name);
                    setEditingName(false);
                  }
                }}
                className="h-auto border-none bg-transparent p-0 text-3xl font-semibold tracking-tight focus-visible:ring-0"
              />
            ) : (
              <h1
                className="text-3xl font-semibold tracking-tight text-foreground cursor-pointer hover:text-foreground/80 transition-colors"
                onClick={() => setEditingName(true)}
              >
                {space.name}
              </h1>
            )}

            {editingDesc ? (
              <Input
                autoFocus
                value={descVal}
                onChange={(e) => setDescVal(e.target.value)}
                onBlur={() => void handleSaveDesc()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setDescVal(space.description);
                    setEditingDesc(false);
                  }
                }}
                placeholder="Add a description..."
                className="mt-2 h-auto border-none bg-transparent p-0 text-sm text-foreground/50 focus-visible:ring-0"
              />
            ) : (
              <p
                className="mt-2 text-sm text-foreground/50 cursor-pointer hover:text-foreground/70 transition-colors"
                onClick={() => setEditingDesc(true)}
              >
                {space.description || "Add a description..."}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-8 lg:flex-row">
            {/* Left column — chat input + recent chats */}
            <div className="min-w-0 flex-1">
              {/* Composer */}
              <div className="mb-6">
                <ChatInput centered={false} />
              </div>

              {/* Recent chats */}
              <div>
                <button
                  onClick={() => setChatsExpanded(!chatsExpanded)}
                  className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/40 hover:text-foreground/60 transition-colors"
                >
                  {chatsExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Recent chats
                  {spaceSessions.length > 0 && (
                    <span className="ml-0.5 text-foreground/25">{spaceSessions.length}</span>
                  )}
                </button>
                {chatsExpanded && (
                  spaceSessions.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-foreground/10 px-6 py-8 text-center">
                      <p className="text-sm text-foreground/40">
                        Start a chat to keep conversations organized and re-use project knowledge.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-1">
                      {spaceSessions.map((s) => (
                        <li key={s.id}>
                          <button
                            onClick={() => handleOpenChat(s.id)}
                            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {s.title}
                            </span>
                            <span className="shrink-0 text-[11px] text-foreground/30">
                              {relativeDay(s.updated_at)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            </div>

            {/* Right column — instructions + files */}
            <div className="w-full lg:w-72 shrink-0 space-y-6">
              {/* Instructions */}
              <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
                <button
                  className="flex w-full items-center justify-between text-sm font-medium text-foreground/80"
                  onClick={() => setInstructionsOpen(!instructionsOpen)}
                >
                  Instructions
                  <Plus
                    className={cn(
                      "h-4 w-4 text-foreground/40 transition-transform",
                      instructionsOpen && "rotate-45",
                    )}
                  />
                </button>
                {!instructionsOpen && !space.instructions && (
                  <p className="mt-1 text-xs text-foreground/35">
                    Add instructions to tailor responses
                  </p>
                )}
                {(instructionsOpen || space.instructions) && (
                  <Textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    onBlur={() => void handleSaveInstructions()}
                    placeholder="Add custom instructions for all chats in this space..."
                    className="mt-3 min-h-[120px] rounded-xl border-foreground/10 bg-foreground/[0.03] text-sm"
                  />
                )}
              </div>

              {/* Files */}
              <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground/80">
                    Files
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-foreground/30">
                      {files.length}/12
                    </span>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={files.length >= 12}
                      className="text-foreground/40 hover:text-foreground transition-colors disabled:opacity-30"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void handleAddFiles(e.target.files);
                    e.target.value = "";
                  }}
                />

                {files.length > 0 ? (
                  <ul className="mt-3 space-y-1">
                    {files.map((f) => (
                      <li
                        key={f.id}
                        className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-foreground/[0.04] transition-colors"
                      >
                        {f.kind === "image" ? (
                          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-foreground/70">
                          {f.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-foreground/25">
                          {formatSize(f.size)}
                        </span>
                        <button
                          onClick={() => void handleRemoveFile(f.id)}
                          className="shrink-0 opacity-0 group-hover:opacity-100 text-foreground/40 hover:text-destructive transition-all"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-3 rounded-xl border border-dashed border-foreground/10 px-4 py-6 text-center">
                    <p className="text-xs text-foreground/35">
                      Add PDFs, documents, or other text to reference in this space.
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 text-xs"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Plus className="h-3 w-3" />
                      Add file
                    </Button>
                  </div>
                )}

                {fileError && (
                  <p className="mt-2 text-xs text-destructive">{fileError}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
