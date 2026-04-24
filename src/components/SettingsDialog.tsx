import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  Clock,
  Github,
  Globe,
  Info,
  Layers,
  MessageSquareText,
  MoreHorizontal,
  Palette,
  Plug,
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
import { McpPanel } from "@/components/McpPanel";
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
  { value: "mcp", label: "MCP", icon: Plug },
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

                <Separator />

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label className="flex items-center gap-1.5">
                        <Globe className="h-3.5 w-3.5 text-foreground/60" />
                        Web fetch
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        When your message contains an{" "}
                        <span className="font-mono">http(s)://</span> URL,
                        Loach downloads the page, extracts the readable text,
                        and appends it to the prompt so the model can read it.
                        Up to 3 URLs per message, 5&nbsp;MB each, 15&nbsp;s
                        timeout. Private IPs are blocked.
                      </p>
                    </div>
                    <Button
                      variant={settings.web_fetch_enabled ? "default" : "outline"}
                      onClick={() =>
                        settings.update(
                          "web_fetch_enabled",
                          !settings.web_fetch_enabled,
                        )
                      }
                      className="shrink-0"
                    >
                      {settings.web_fetch_enabled ? "On" : "Off"}
                    </Button>
                  </div>
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

              <TabsContent value="mcp" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
                <McpPanel />
              </TabsContent>

              <TabsContent value="appearance" className="mt-0 space-y-7 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Appearance</SectionTitle>

                {/* ── Theme: Solid vs Aurora ────────────────────────────
                     Naming note: we keep the persisted value names
                     ("solid" / "gradient") unchanged for backwards
                     compatibility with the SQLite KV store and only
                     relabel in the UI ("Aurora" is the glass-mesh look). */}
                <div>
                  <Label>Theme</Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    Aurora layers an animated mesh behind the glass surfaces. Solid keeps a single flat background.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <AppearanceTile
                      title="Solid"
                      selected={settings.background_style === "solid"}
                      onClick={() => settings.update("background_style", "solid")}
                    >
                      <ThemePreview variant="solid" mode={resolveMode(settings.theme)} />
                    </AppearanceTile>
                    <AppearanceTile
                      title="Aurora"
                      selected={settings.background_style === "gradient"}
                      onClick={() => settings.update("background_style", "gradient")}
                    >
                      <ThemePreview variant="gradient" mode={resolveMode(settings.theme)} />
                    </AppearanceTile>
                  </div>
                </div>

                <Separator />

                {/* ── Color mode: Light / System / Dark ───────────────── */}
                <div>
                  <Label>Color mode</Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    "System" follows your OS preference and updates live.
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <AppearanceTile
                      title="Light"
                      selected={settings.theme === "light"}
                      onClick={() => settings.update("theme", "light")}
                    >
                      <ColorModePreview mode="light" variant={settings.background_style} />
                    </AppearanceTile>
                    <AppearanceTile
                      title="System"
                      selected={settings.theme === "system"}
                      onClick={() => settings.update("theme", "system")}
                    >
                      <ColorModePreview mode="system" variant={settings.background_style} />
                    </AppearanceTile>
                    <AppearanceTile
                      title="Dark"
                      selected={settings.theme === "dark"}
                      onClick={() => settings.update("theme", "dark")}
                    >
                      <ColorModePreview mode="dark" variant={settings.background_style} />
                    </AppearanceTile>
                  </div>
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

/* ───────────────────────── Appearance tiles ─────────────────────────
 *
 * Card-style selectors inspired by ChatGPT's appearance picker: each
 * tile shows a miniature mockup of the app rendered with the option's
 * palette, plus a check indicator + label underneath. Selected tile
 * gets a primary-coloured ring so the choice reads at a glance.
 *
 * Kept local to this file — the mini-mockup is bespoke to the Loach
 * layout (sidebar + chat column + input bar) and has no reason to
 * live elsewhere.
 * ─────────────────────────────────────────────────────────────────── */

type Tone = "light" | "dark";
type Variant = "solid" | "gradient";

function resolveMode(theme: "light" | "dark" | "system"): Tone {
  if (theme === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  }
  return theme;
}

function AppearanceTile({
  title,
  selected,
  onClick,
  children,
}: {
  title: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl text-left",
        "border-2 transition-all duration-200",
        selected
          ? "border-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]"
          : "border-foreground/10 hover:border-foreground/25 hover:-translate-y-0.5",
      )}
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden">
        {children}
      </div>
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2 transition-colors",
          selected ? "bg-primary/5" : "bg-transparent",
        )}
      >
        <span className="text-[13px] font-medium">{title}</span>
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-foreground/25 group-hover:border-foreground/45",
          )}
          aria-hidden
        >
          {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      </div>
    </button>
  );
}

/** Backdrop for a mini preview — mirrors `app-mesh` / `app-solid` in globals.css. */
function PreviewBackdrop({ variant, mode }: { variant: Variant; mode: Tone }) {
  if (variant === "solid") {
    return (
      <div
        className="absolute inset-0"
        style={{ background: mode === "dark" ? "#0b0d14" : "#f4efe8" }}
      />
    );
  }
  // Aurora — radial blurs layered on a diagonal base, matching the real app.
  const bg =
    mode === "dark"
      ? [
          "radial-gradient(at 6% 16%, hsla(225, 75%, 22%, 0.95) 0px, transparent 55%)",
          "radial-gradient(at 18% 82%, hsla(255, 60%, 22%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 58% 28%, hsla(305, 60%, 28%, 0.55) 0px, transparent 55%)",
          "radial-gradient(at 82% 58%, hsla(14, 80%, 42%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 96% 88%, hsla(8, 85%, 38%, 0.85) 0px, transparent 55%)",
          "linear-gradient(125deg, #080a1a 0%, #140e22 35%, #361618 70%, #4a1a10 100%)",
        ].join(", ")
      : [
          "radial-gradient(at 6% 16%, hsla(28, 95%, 88%, 0.95) 0px, transparent 55%)",
          "radial-gradient(at 16% 82%, hsla(202, 85%, 90%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 58% 28%, hsla(268, 70%, 93%, 0.65) 0px, transparent 55%)",
          "radial-gradient(at 82% 58%, hsla(18, 92%, 84%, 0.85) 0px, transparent 55%)",
          "radial-gradient(at 96% 88%, hsla(342, 85%, 90%, 0.85) 0px, transparent 55%)",
          "linear-gradient(125deg, #f4f2e7 0%, #eee0f2 35%, #f8d7cf 70%, #f8c9a8 100%)",
        ].join(", ");
  return <div className="absolute inset-0" style={{ backgroundImage: bg }} />;
}

/** Miniature of the Loach layout (sidebar + main + composer). */
function MiniUIFrame({ mode, variant }: { mode: Tone; variant: Variant }) {
  const isDark = mode === "dark";
  // Aurora uses semi-transparent glass so the mesh shows through; solid uses
  // a slightly more opaque chrome.
  const glass = isDark
    ? variant === "gradient"
      ? "rgba(255,255,255,0.07)"
      : "rgba(255,255,255,0.05)"
    : variant === "gradient"
      ? "rgba(255,255,255,0.55)"
      : "rgba(0,0,0,0.035)";
  const stroke = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";
  const fg = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.7)";
  const muted = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)";
  const accent = "hsl(14, 85%, 55%)";

  return (
    <div className="absolute inset-0 flex gap-1 p-1.5">
      {/* Sidebar */}
      <div
        className="flex w-[26%] flex-col gap-1 rounded-[5px] p-1.5"
        style={{ background: glass, boxShadow: `inset 0 0 0 1px ${stroke}` }}
      >
        <div className="h-1 rounded-sm" style={{ background: accent, width: "60%" }} />
        <div className="mt-1 h-0.5 rounded-sm" style={{ background: muted, width: "80%" }} />
        <div className="h-0.5 rounded-sm" style={{ background: muted, width: "55%" }} />
        <div className="h-0.5 rounded-sm" style={{ background: muted, width: "70%" }} />
      </div>

      {/* Main column */}
      <div className="flex flex-1 flex-col gap-1">
        {/* Messages area */}
        <div className="flex flex-1 flex-col justify-end gap-1 pr-1">
          <div
            className="ml-auto h-2 rounded-[3px]"
            style={{ background: accent, opacity: 0.85, width: "55%" }}
          />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "90%" }} />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "75%" }} />
          <div className="h-0.5 rounded-sm" style={{ background: fg, opacity: 0.5, width: "82%" }} />
        </div>
        {/* Composer */}
        <div
          className="h-3 rounded-[4px]"
          style={{ background: glass, boxShadow: `inset 0 0 0 1px ${stroke}` }}
        />
      </div>
    </div>
  );
}

function ThemePreview({ variant, mode }: { variant: Variant; mode: Tone }) {
  return (
    <>
      <PreviewBackdrop variant={variant} mode={mode} />
      <MiniUIFrame variant={variant} mode={mode} />
    </>
  );
}

/**
 * Color-mode preview. For "system" we clip a light mockup and a dark mockup
 * along a diagonal so the tile reads as "whichever matches your OS".
 */
function ColorModePreview({
  mode,
  variant,
}: {
  mode: "light" | "dark" | "system";
  variant: Variant;
}) {
  if (mode !== "system") {
    return <ThemePreview variant={variant} mode={mode} />;
  }
  return (
    <>
      {/* Light half (top-left) */}
      <div
        className="absolute inset-0"
        style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}
      >
        <ThemePreview variant={variant} mode="light" />
      </div>
      {/* Dark half (bottom-right) */}
      <div
        className="absolute inset-0"
        style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
      >
        <ThemePreview variant={variant} mode="dark" />
      </div>
      {/* Split hairline */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom left, transparent calc(50% - 0.5px), rgba(255,255,255,0.35) 50%, transparent calc(50% + 0.5px))",
        }}
        aria-hidden
      />
    </>
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
