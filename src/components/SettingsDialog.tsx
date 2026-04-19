import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Clock,
  Github,
  Info,
  Layers,
  MessageSquareText,
  MoreHorizontal,
  Palette,
  Server,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";
import pkg from "../../package.json";

const GITHUB_URL = "https://github.com/ztcs-software/loach";
const DOCS_URL = "#";

async function openExternal(url: string) {
  if (url === "#" || !url) return;
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

const NAV = [
  { value: "providers", label: "Providers", icon: Server },
  { value: "prompt", label: "System prompt", icon: MessageSquareText },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "archive", label: "Archive", icon: Archive },
  { value: "about", label: "About", icon: Info },
] as const;

export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const settingsTab = useUIStore((s) => s.settingsTab);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const settings = useSettingsStore();

  const [pendingKey, setPendingKey] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl !rounded-3xl overflow-hidden p-0 gap-0">
        {/* Keep Radix a11y metadata — visually hidden since the sidebar owns the heading */}
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure providers, system prompts, appearance, and more.
        </DialogDescription>

        <Tabs
          value={settingsTab}
          onValueChange={(v) => setSettingsTab(v as typeof settingsTab)}
          orientation="vertical"
          className="flex h-[540px] max-h-[85vh]"
        >
          {/* ─────────── Left column: vertical nav ─────────── */}
          <div className="flex w-56 shrink-0 flex-col border-r border-foreground/[0.06] p-3">
            <div className="px-2 pb-4 pt-1.5">
              <h2 className="text-base font-semibold tracking-tight">Settings</h2>
            </div>
            <TabsList
              className={
                // `!` modifiers override the shared primitive's pill/card baseline
                "!flex !h-auto !flex-col !items-stretch !justify-start !gap-0.5 " +
                "!rounded-none !border-0 !bg-transparent !p-0 !backdrop-blur-none " +
                "text-foreground/70 shadow-none"
              }
            >
              {NAV.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={
                    "group relative !justify-start gap-2.5 rounded-xl px-3 py-2 text-sm font-normal " +
                    "text-foreground/65 shadow-none transition-colors " +
                    "hover:bg-foreground/[0.06] hover:text-foreground " +
                    "data-[state=active]:!bg-foreground/10 data-[state=active]:text-foreground " +
                    "data-[state=active]:shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]"
                  }
                >
                  <Icon className="h-4 w-4 shrink-0 text-foreground/55 transition-colors group-hover:text-foreground/85 group-data-[state=active]:text-primary" />
                  <span>{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* ─────────── Right column: scrolling content ─────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-8 pb-8 pt-6 pr-14">
              {/* pr-14 keeps the scrolling content clear of the dialog's absolute close X */}

              <TabsContent value="providers" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Providers</SectionTitle>

                <div>
                  <Label>Ollama base URL</Label>
                  <Input
                    className="mt-1.5"
                    value={settings.ollama_base_url}
                    onChange={(e) => settings.update("ollama_base_url", e.target.value)}
                    placeholder="http://localhost:11434"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Auto-detected on app launch. Leave default unless you run Ollama remotely.
                  </p>
                </div>

                <Separator />

                <div>
                  <Label>OpenAI base URL</Label>
                  <Input
                    className="mt-1.5"
                    value={settings.openai_base_url}
                    onChange={(e) => settings.update("openai_base_url", e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Override to use vLLM, LM Studio, LiteLLM or any OpenAI-compatible proxy.
                  </p>
                </div>

                <div>
                  <Label>OpenAI API key</Label>
                  <div className="mt-1.5 flex gap-2">
                    <Input
                      type="password"
                      placeholder={settings.openai_key_set ? "•••••••• (stored)" : "sk-…"}
                      value={pendingKey}
                      onChange={(e) => setPendingKey(e.target.value)}
                    />
                    <Button
                      disabled={busy || !pendingKey}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await settings.setOpenAIKey(pendingKey);
                          setPendingKey("");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Save
                    </Button>
                    {settings.openai_key_set && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await settings.clearOpenAIKey();
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Stored in your OS credential manager (Windows Credential Manager / Linux Secret Service).
                    Never written to disk in plain text.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="prompt" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>System prompt</SectionTitle>
                <div>
                  <Label>Global system prompt</Label>
                  <Textarea
                    rows={12}
                    className="mt-1.5 resize-none"
                    value={settings.global_system_prompt}
                    onChange={(e) =>
                      settings.update("global_system_prompt", e.target.value)
                    }
                    placeholder="You are a helpful assistant…"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Applied to every new chat. Individual chats can override this from the parameter panel.
                  </p>
                </div>

                <Separator />

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-foreground/60" />
                        Temporal awareness
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Inject the current date, time, weekday, and timezone
                        into every system prompt so the model can answer
                        questions like "what day is it today?". Drawn from
                        your local clock.
                      </p>
                    </div>
                    <Button
                      variant={settings.temporal_awareness ? "default" : "outline"}
                      onClick={() =>
                        settings.update(
                          "temporal_awareness",
                          !settings.temporal_awareness,
                        )
                      }
                      className="shrink-0"
                    >
                      {settings.temporal_awareness ? "On" : "Off"}
                    </Button>
                  </div>
                  <div className="mt-3 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-[11px] leading-relaxed text-foreground/60">
                    <p className="mb-1 font-medium text-foreground/75">
                      Template variables
                    </p>
                    <p>
                      Use these inside any system prompt to place the values
                      exactly where you want them. When used, the automatic
                      preamble is skipped.
                    </p>
                    <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                      <li>{"{{CURRENT_DATE}}"} → 2026-04-17</li>
                      <li>{"{{CURRENT_TIME}}"} → 14:32</li>
                      <li>{"{{CURRENT_WEEKDAY}}"} → Friday</li>
                      <li>{"{{CURRENT_DATETIME}}"} → 2026-04-17 14:32</li>
                      <li>{"{{CURRENT_TIMEZONE}}"} → Europe/Warsaw</li>
                    </ul>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="appearance" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Appearance</SectionTitle>

                <div>
                  <Label>Theme</Label>
                  <div className="mt-2 flex gap-2">
                    {(["light", "dark", "system"] as const).map((t) => (
                      <Button
                        key={t}
                        variant={settings.theme === t ? "default" : "outline"}
                        onClick={() => settings.update("theme", t)}
                        className="capitalize"
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    "System" follows your OS preference and updates live.
                  </p>
                </div>

                <Separator />

                <div>
                  <Label>Background</Label>
                  <div className="mt-2 flex gap-2">
                    {(["gradient", "solid"] as const).map((b) => (
                      <Button
                        key={b}
                        variant={settings.background_style === b ? "default" : "outline"}
                        onClick={() => settings.update("background_style", b)}
                        className="capitalize"
                      >
                        {b}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Gradient = animated mesh blur. Solid = a single flat surface that follows the active theme.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="archive" className="mt-0 space-y-4 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Archive</SectionTitle>
                <p className="text-[13px] text-foreground/55">
                  Chats you've moved out of the main list. Unarchive to bring
                  them back, or delete permanently.
                </p>
                <ArchivePanel onOpenChat={() => setOpen(false)} />
              </TabsContent>

              <TabsContent value="about" className="mt-0 space-y-5 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>About</SectionTitle>
                <div className="flex items-baseline gap-3">
                  <h3 className="text-2xl font-semibold tracking-tight">Loach</h3>
                  <span className="font-mono text-xs text-foreground/50">
                    v{pkg.version}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-foreground/75">
                  A native desktop chat client for local and OpenAI-compatible LLMs.
                  Your conversations, keys, and files stay on your machine.
                </p>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void openExternal(GITHUB_URL)}
                    className="gap-2"
                  >
                    <Github className="h-4 w-4" />
                    GitHub
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void openExternal(DOCS_URL)}
                    className="gap-2"
                    disabled={DOCS_URL === "#"}
                    title={DOCS_URL === "#" ? "Coming soon" : undefined}
                  >
                    <BookOpen className="h-4 w-4" />
                    Docs
                  </Button>
                </div>
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-lg font-semibold tracking-tight">{children}</h3>
  );
}

/**
 * Embedded Archive browser — same rows the old full-page ArchiveView had,
 * just squeezed into the Settings dialog's right column. Opening a chat
 * closes the dialog so the user lands straight in the chat.
 */
function ArchivePanel({ onOpenChat }: { onOpenChat: () => void }) {
  const sessions = useChatStore((s) => s.sessions);
  const archive = useChatStore((s) => s.archive);
  const remove = useChatStore((s) => s.remove);
  const select = useChatStore((s) => s.selectSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);

  const archived = sessions
    .filter((s) => s.archived_at != null)
    .sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));

  const handleOpen = async (id: string) => {
    setViewingSpace(null);
    await select(id);
    onOpenChat();
  };

  if (archived.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.02] px-8 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-foreground/[0.06] text-foreground/60">
          <Archive className="h-4 w-4" />
        </div>
        <h2 className="mt-3 text-sm font-medium">Nothing archived</h2>
        <p className="mt-1 max-w-md text-[12px] text-foreground/55">
          Right-click a chat in the sidebar and choose <em>Move to Archive</em>{" "}
          to stash it here without losing the history.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 bg-foreground/[0.03]">
      {archived.map((s) => (
        <ArchivedRow
          key={s.id}
          session={s}
          onOpen={() => void handleOpen(s.id)}
          onUnarchive={() => void archive(s.id, false)}
          onDelete={() => void remove(s.id)}
        />
      ))}
    </ul>
  );
}

function ArchivedRow({
  session,
  onOpen,
  onUnarchive,
  onDelete,
}: {
  session: Session;
  onOpen: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const archivedOn = session.archived_at
    ? new Date(session.archived_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";

  return (
    <li
      className={cn(
        "group flex items-center gap-2 px-3 py-2.5 transition-colors",
        "hover:bg-foreground/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85">
          {session.title}
        </span>
        {session.space_id && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-foreground/55">
            <Layers className="h-2.5 w-2.5" />
            Space
          </span>
        )}
        <span className="shrink-0 text-[11px] text-foreground/40">
          {archivedOn}
        </span>
      </button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onUnarchive}
        className="h-7 gap-1 rounded-lg px-2 text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
      >
        <ArchiveRestore className="h-3.5 w-3.5" />
        Unarchive
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Archived chat actions"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onUnarchive}>
            <ArchiveRestore className="h-4 w-4" /> Unarchive
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Delete permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
