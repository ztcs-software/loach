import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  ChevronDown,
  Clock,
  Database,
  Download,
  Github,
  Globe,
  Info,
  Layers,
  Loader2,
  Lock,
  MemoryStick,
  MoreHorizontal,
  Palette,
  Plug,
  RotateCcw,
  Server,
  Trash2,
  Upload,
  User,
  Wrench,
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
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { McpPanel } from "@/components/McpPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { Logo } from "@/components/Logo";
import { Switch } from "@/components/ui/switch";
import {
  archiveAllSessions,
  exportDataJson,
  factoryReset,
  importDataJson,
  isTauri,
  wipeUserData,
  writeTextFile,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { FontSize, ImportStats, ModelInfo, ProviderId, Session } from "@/types";
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
  { value: "general", label: "General", icon: User },
  { value: "providers", label: "Providers", icon: Server },
  { value: "tools", label: "Tools", icon: Wrench },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "mcp", label: "MCP", icon: Plug },
  { value: "archive", label: "Archive", icon: Archive },
  { value: "data", label: "Data", icon: Database },
  { value: "security", label: "Security", icon: Lock },
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
      {/* Slide-in/out from the LEFT — the Settings entry lives in the
          sidebar's bottom-left corner, so animating from the same side gives
          the click a clear sense of origin.

          Subtle but important: the base DialogContent centres itself with
          `-translate-x-1/2 -translate-y-1/2`, but tailwindcss-animate's
          enter/exit keyframes set `transform: translate3d(...)` directly,
          which *replaces* that centring during the animation. If we used a
          fixed-pixel slide like `slide-in-from-left-8`, the dialog would
          start at `translate(-2rem, 0)` (near the top of the viewport
          centre, not centred), then snap down to `translate(-50%, -50%)`
          when the animation ends — which the eye reads as "from the upper
          right", not the left.

          So we pin the Y translate to `-50%` (no vertical motion) and start
          the X translate at `-65%` (15% of the dialog's width to the left
          of centred), animating to the natural `-50%`. The result: a clean
          horizontal slide of ~15% of the dialog's width, no vertical jump. */}
      <DialogContent className="max-w-3xl !rounded-3xl overflow-hidden p-0 gap-0 duration-200 data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1/2 data-[state=open]:slide-in-from-left-[65%] data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1/2 data-[state=closed]:slide-out-to-left-[65%]">
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

              <TabsContent value="general" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>General</SectionTitle>

                <div>
                  <Label>Your name</Label>
                  <Input
                    className="mt-1.5"
                    value={settings.user_name}
                    onChange={(e) => settings.update("user_name", e.target.value)}
                    placeholder="Your name"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Optional. Available as{" "}
                    <span className="font-mono">{"{{USER_NAME}}"}</span> in
                    custom instructions, so you can write things like
                    "Address me as {"{{USER_NAME}}"}".
                  </p>
                </div>

                <Separator />

                <div>
                  <Label>Default model</Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    Which model new chats start in. "Use most recent" is
                    usually the right pick — it just picks up wherever you
                    left off.
                  </p>
                  <DefaultModelPicker className="mt-2.5" />
                </div>

                <Separator />

                <div>
                  <Label>Custom instructions</Label>
                  <Textarea
                    rows={10}
                    className="mt-1.5 resize-none"
                    value={settings.global_system_prompt}
                    onChange={(e) =>
                      settings.update("global_system_prompt", e.target.value)
                    }
                    placeholder="You are a helpful assistant…"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Applied to every new chat. Individual chats can override
                    this from the parameter panel. Supports the template
                    variables below.
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
                    <Switch
                      checked={settings.temporal_awareness}
                      onCheckedChange={(next) =>
                        settings.update("temporal_awareness", next)
                      }
                      className="shrink-0"
                      aria-label={
                        settings.temporal_awareness
                          ? "Disable temporal awareness"
                          : "Enable temporal awareness"
                      }
                    />
                  </div>
                  <div className="mt-3 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-[11px] leading-relaxed text-foreground/60">
                    <p className="mb-1 font-medium text-foreground/75">
                      Template variables
                    </p>
                    <p>
                      Use these inside Custom instructions (or any per-chat
                      system prompt) to place the values exactly where you
                      want them. When a temporal variable is used, the
                      automatic preamble is skipped.
                    </p>
                    <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                      <li>{"{{USER_NAME}}"} → {settings.user_name || "(unset)"}</li>
                      <li>{"{{CURRENT_DATE}}"} → 2026-04-17</li>
                      <li>{"{{CURRENT_TIME}}"} → 14:32</li>
                      <li>{"{{CURRENT_WEEKDAY}}"} → Friday</li>
                      <li>{"{{CURRENT_DATETIME}}"} → 2026-04-17 14:32</li>
                      <li>{"{{CURRENT_TIMEZONE}}"} → Europe/Warsaw</li>
                    </ul>
                  </div>
                </div>

                <Separator />

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label className="flex items-center gap-1.5">
                        <MemoryStick className="h-3.5 w-3.5 text-foreground/60" />
                        Low VRAM mode
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Force Ollama into low-VRAM mode for every chat —
                        smaller batches and a leaner KV cache. Overrides the
                        per-chat Low&nbsp;VRAM toggle in the Parameters
                        sidebar so you don't have to flip it on each new
                        session. Off by default. Ignored by OpenAI providers.
                      </p>
                    </div>
                    <Switch
                      checked={settings.low_vram_global}
                      onCheckedChange={(next) =>
                        settings.update("low_vram_global", next)
                      }
                      className="shrink-0"
                      aria-label={
                        settings.low_vram_global
                          ? "Disable global Low VRAM mode"
                          : "Enable global Low VRAM mode"
                      }
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="tools" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Tools</SectionTitle>
                <p className="text-[13px] text-foreground/55">
                  Capabilities Loach can offer the model alongside its own
                  knowledge. Each is opt-in.
                </p>

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
                    <Switch
                      checked={settings.web_fetch_enabled}
                      onCheckedChange={(next) =>
                        settings.update("web_fetch_enabled", next)
                      }
                      className="shrink-0"
                      aria-label={
                        settings.web_fetch_enabled
                          ? "Disable web fetch"
                          : "Enable web fetch"
                      }
                    />
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

                <Separator />

                {/* ── Font size: Small / Normal / Large ────────────────── */}
                <div>
                  <Label>Font size</Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    Scales text across the whole app. Normal is the default.
                  </p>
                  <FontSizeSwitch
                    value={settings.font_size}
                    onChange={(next) => settings.update("font_size", next)}
                  />
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

              <TabsContent value="data" className="mt-0 space-y-5 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Data</SectionTitle>
                <p className="text-[13px] text-foreground/55">
                  Back up, restore, or clear everything Loach has stored on
                  this machine. Exports include chats, messages, spaces,
                  snippets, MCP servers, and app settings — never your API
                  key (that stays in your OS credential manager).
                </p>
                <DataPanel onCloseDialog={() => setOpen(false)} />
              </TabsContent>

              <TabsContent value="security" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Security</SectionTitle>
                <div className="mt-5">
                  <SecurityPanel />
                </div>
              </TabsContent>

              <TabsContent value="about" className="mt-0 space-y-5 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>About</SectionTitle>
                <div className="flex items-center gap-4">
                  <Logo size={56} ariaHidden />
                  <div className="flex items-baseline gap-3">
                    <h3 className="text-2xl font-semibold tracking-tight">Loach</h3>
                    <span className="font-mono text-xs text-foreground/50">
                      v{pkg.version}
                    </span>
                  </div>
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

/* ─────────────────────── Default-model picker ───────────────────────
 *
 * Encodes the user's "what model should new chats start in" preference
 * as a single string so it round-trips through the string-keyed KV
 * settings table without serialisation gymnastics:
 *
 *   "recent"                  → use whatever the user touched last
 *   "provider:<id>"           → pin to that provider (most recent model)
 *   "model:<provider>:<id>"   → always start in this exact model
 *
 * The encoding lives in `chatStore.resolveDefaultModelChoice` too — keep
 * the two in sync.
 *
 * The picker reads the live model list from `useModelsStore`; if it's
 * empty (e.g. Ollama unreachable, no OpenAI key) the model section just
 * collapses and the user is left with "recent" + per-provider choices,
 * which still works.
 * ─────────────────────────────────────────────────────────────────── */

function decodeModelChoice(
  choice: string,
):
  | { kind: "recent" }
  | { kind: "provider"; provider: ProviderId }
  | { kind: "model"; provider: ProviderId; model: string } {
  if (choice.startsWith("model:")) {
    const rest = choice.slice("model:".length);
    const sep = rest.indexOf(":");
    if (sep > 0) {
      const p = rest.slice(0, sep);
      const m = rest.slice(sep + 1);
      if ((p === "ollama" || p === "openai") && m) {
        return { kind: "model", provider: p, model: m };
      }
    }
  }
  if (choice.startsWith("provider:")) {
    const p = choice.slice("provider:".length);
    if (p === "ollama" || p === "openai") {
      return { kind: "provider", provider: p };
    }
  }
  return { kind: "recent" };
}

function describeChoice(
  choice: string,
  models: ModelInfo[],
): string {
  const decoded = decodeModelChoice(choice);
  if (decoded.kind === "recent") return "Use most recent";
  if (decoded.kind === "provider") {
    return decoded.provider === "ollama"
      ? "Use last Ollama model"
      : "Use last OpenAI model";
  }
  // Show the model's friendly label if we have it; fall back to the raw id
  // so a model that's currently unreachable still reads as something
  // recognisable.
  const hit = models.find(
    (m) => m.provider === decoded.provider && m.id === decoded.model,
  );
  return hit?.label || decoded.model;
}

function DefaultModelPicker({ className }: { className?: string }) {
  const choice = useSettingsStore((s) => s.default_model_choice);
  const update = useSettingsStore((s) => s.update);
  const models = useModelsStore((s) => s.models);

  // Group by provider so the menu reads "Ollama / OpenAI" rather than a
  // flat alphabetical wall. Memoised because `models` is a new array on
  // every refresh.
  const grouped = useMemo(() => {
    const ollama = models.filter((m) => m.provider === "ollama");
    const openai = models.filter((m) => m.provider === "openai");
    return { ollama, openai };
  }, [models]);

  const label = describeChoice(choice, models);

  const set = (next: string) => void update("default_model_choice", next);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.03] px-3 py-2 text-left text-[13px] transition-colors",
            "hover:bg-foreground/[0.06] focus:outline-none focus:ring-2 focus:ring-primary/40",
            className,
          )}
        >
          <span className="truncate text-foreground/85">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground/55" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[--radix-dropdown-menu-trigger-width] overflow-y-auto"
      >
        <DropdownMenuItem onSelect={() => set("recent")}>
          <ChoiceCheck active={choice === "recent"} />
          Use most recent
        </DropdownMenuItem>

        <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-foreground/45">
          Pin to provider
        </div>
        <DropdownMenuItem onSelect={() => set("provider:ollama")}>
          <ChoiceCheck active={choice === "provider:ollama"} />
          Use last Ollama model
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => set("provider:openai")}>
          <ChoiceCheck active={choice === "provider:openai"} />
          Use last OpenAI model
        </DropdownMenuItem>

        {grouped.ollama.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-foreground/45">
              Ollama models
            </div>
            {grouped.ollama.map((m) => {
              const v = `model:ollama:${m.id}`;
              return (
                <DropdownMenuItem key={v} onSelect={() => set(v)}>
                  <ChoiceCheck active={choice === v} />
                  <span className="truncate">{m.label}</span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {grouped.openai.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-foreground/45">
              OpenAI models
            </div>
            {grouped.openai.map((m) => {
              const v = `model:openai:${m.id}`;
              return (
                <DropdownMenuItem key={v} onSelect={() => set(v)}>
                  <ChoiceCheck active={choice === v} />
                  <span className="truncate">{m.label}</span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChoiceCheck({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center",
        active ? "text-primary" : "text-transparent",
      )}
    >
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </span>
  );
}

/* ───────────────────────── Font-size switch ─────────────────────────
 *
 * Three-way segmented control for the global font scale. Each option
 * previews its own size in the label so users can eyeball the choice
 * without applying it. Selection writes the value to settings, where
 * `applyFontSize` flips a class on <html> and the CSS in globals.css
 * reads `--font-scale`.
 * ─────────────────────────────────────────────────────────────────── */

const FONT_SIZE_OPTIONS: { value: FontSize; label: string; previewPx: number }[] = [
  { value: "small",  label: "Small",  previewPx: 12 },
  { value: "normal", label: "Normal", previewPx: 14 },
  { value: "large",  label: "Large",  previewPx: 16 },
];

function FontSizeSwitch({
  value,
  onChange,
}: {
  value: FontSize;
  onChange: (next: FontSize) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Font size"
      className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-1"
    >
      {FONT_SIZE_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-xl px-3 py-2.5 transition-colors",
              selected
                ? "bg-primary/10 text-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]"
                : "text-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            <span
              className="font-medium leading-none"
              style={{ fontSize: `${opt.previewPx}px` }}
            >
              Aa
            </span>
            <span className="text-[11px] text-foreground/65">{opt.label}</span>
          </button>
        );
      })}
    </div>
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

/* ───────────────────────── Data tab panel ─────────────────────────
 *
 * Four bulk operations live here:
 *
 *   1. Export   — dump the whole DB to a JSON file via a save dialog.
 *   2. Import   — pick a JSON dump, replace everything with its contents,
 *                 then reload the window so every store re-hydrates from
 *                 the freshly-written DB.
 *   3. Archive all — flip every live chat to archived in one shot.
 *   4. Erase    — two-mode destructive flow (user-data vs factory reset),
 *                 gated on a typed "YES" confirmation.
 *
 * The destructive actions rebuild the whole app by calling
 * `window.location.reload()` — every Zustand store derives from SQLite
 * on mount (see App.tsx's hydrate useEffect), so a reload is the
 * cheapest way to get back to a consistent state without writing a
 * bespoke rehydrate function per store.
 * ─────────────────────────────────────────────────────────────────── */

type BusyKind = "export" | "import" | "archive-all" | null;

function DataPanel({ onCloseDialog: _onCloseDialog }: { onCloseDialog: () => void }) {
  const [busy, setBusy] = useState<BusyKind>(null);
  const [message, setMessage] = useState<{
    tone: "info" | "error";
    text: string;
  } | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);

  // A tiny toast-lite: the feedback message auto-clears after 5s so long-
  // running exports don't leave stale success chips behind when the user
  // pokes Export a second time.
  const flash = (tone: "info" | "error", text: string) => {
    setMessage({ tone, text });
    window.setTimeout(() => {
      setMessage((m) => (m && m.text === text ? null : m));
    }, 5000);
  };

  const handleExport = async () => {
    if (!isTauri) {
      flash("error", "Export requires the desktop app.");
      return;
    }
    setBusy("export");
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await save({
        defaultPath: `loach-export-${stamp}.json`,
        filters: [{ name: "Loach export", extensions: ["json"] }],
      });
      if (!path) {
        setBusy(null);
        return; // user cancelled
      }
      const payload = await exportDataJson();
      await writeTextFile(path, payload);
      flash("info", `Exported to ${path}`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    if (!isTauri) {
      flash("error", "Import requires the desktop app.");
      return;
    }
    const confirmed = window.confirm(
      "Importing replaces ALL current chats, spaces, snippets, MCP servers, " +
        "and settings with the contents of the file. Your stored OpenAI API " +
        "key is not touched. Continue?",
    );
    if (!confirmed) return;

    setBusy("import");
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Loach export", extensions: ["json"] }],
      });
      // The open() API returns a string | null on single-select in Tauri 2.
      const path = typeof selected === "string" ? selected : null;
      if (!path) {
        setBusy(null);
        return;
      }
      const stats = await importDataJson(path);
      flash("info", formatImportSummary(stats));
      // Give the toast a beat, then reload so every store re-hydrates
      // from the freshly-written DB.
      window.setTimeout(() => {
        window.location.reload();
      }, 900);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const handleArchiveAll = async () => {
    if (!isTauri) {
      flash("error", "Archive requires the desktop app.");
      return;
    }
    const live = useChatStore
      .getState()
      .sessions.filter((s) => !s.archived_at).length;
    if (live === 0) {
      flash("info", "No live chats to archive.");
      return;
    }
    const confirmed = window.confirm(
      `Move all ${live} live chat${live === 1 ? "" : "s"} to the archive? ` +
        "You can unarchive any of them later from Settings → Archive.",
    );
    if (!confirmed) return;

    setBusy("archive-all");
    try {
      const n = await archiveAllSessions();
      // Re-hydrate the chat store so the sidebar collapses the now-archived
      // sessions and a fresh blank chat is created for the user to land in.
      await useChatStore.getState().hydrate();
      flash("info", `Archived ${n} chat${n === 1 ? "" : "s"}.`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="divide-y divide-foreground/[0.06] rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
        <DataRow
          icon={<Download className="h-4 w-4" />}
          title="Export data"
          description="Save a full database dump — chats, spaces, snippets, MCP servers, and settings — to a JSON file."
          action={
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={busy !== null}
              className="shrink-0"
            >
              {busy === "export" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Exporting…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  Export
                </>
              )}
            </Button>
          }
        />
        <DataRow
          icon={<Upload className="h-4 w-4" />}
          title="Import data"
          description="Restore from a previously exported JSON dump. Replaces everything in the current database."
          action={
            <Button
              variant="outline"
              onClick={handleImport}
              disabled={busy !== null}
              className="shrink-0"
            >
              {busy === "import" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5" />
                  Import
                </>
              )}
            </Button>
          }
        />
        <DataRow
          icon={<Archive className="h-4 w-4" />}
          title="Archive all chats"
          description="Move every live chat to the archive. Nothing is deleted — unarchive individually any time."
          action={
            <Button
              variant="outline"
              onClick={handleArchiveAll}
              disabled={busy !== null}
              className="shrink-0"
            >
              {busy === "archive-all" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Archiving…
                </>
              ) : (
                <>
                  <Archive className="h-3.5 w-3.5" />
                  Archive all
                </>
              )}
            </Button>
          }
        />
      </div>

      {/* Danger zone — a dedicated visually-distinct card so Erase can't be
          mistaken for the more routine Export / Import rows. */}
      <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/[0.06] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-[13.5px] font-semibold text-foreground">
              Erase &amp; Reset
            </h4>
            <p className="mt-1 text-[12px] leading-relaxed text-foreground/60">
              Permanently delete your data, or factory-reset the app to its
              default state. Neither operation can be undone — consider
              exporting first.
            </p>
          </div>
          <Button
            variant="destructive"
            onClick={() => setEraseOpen(true)}
            disabled={busy !== null}
            className="shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Erase…
          </Button>
        </div>
      </div>

      {message && (
        <div
          role="status"
          className={cn(
            "mt-4 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
            message.tone === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-foreground/10 bg-foreground/[0.04] text-foreground/75",
          )}
        >
          {message.text}
        </div>
      )}

      <EraseDialog
        open={eraseOpen}
        onOpenChange={setEraseOpen}
        onDone={(text) => {
          flash("info", text);
          // Full reload so every zustand store re-hydrates from the now-
          // empty DB. Small delay so the success state is visible first.
          window.setTimeout(() => {
            window.location.reload();
          }, 900);
        }}
      />
    </>
  );
}

/** One row in the Data tab's action list. Kept purely presentational so the
 *  busy / disabled logic stays in `DataPanel`. */
function DataRow({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-foreground/75">
          {icon}
        </div>
        <div className="min-w-0">
          <h4 className="text-[13.5px] font-medium text-foreground">{title}</h4>
          <p className="mt-1 text-[12px] leading-relaxed text-foreground/55">
            {description}
          </p>
        </div>
      </div>
      {action}
    </div>
  );
}

function formatImportSummary(s: ImportStats): string {
  const parts: string[] = [];
  if (s.sessions) parts.push(`${s.sessions} chat${s.sessions === 1 ? "" : "s"}`);
  if (s.messages) parts.push(`${s.messages} message${s.messages === 1 ? "" : "s"}`);
  if (s.spaces) parts.push(`${s.spaces} space${s.spaces === 1 ? "" : "s"}`);
  if (s.snippets) parts.push(`${s.snippets} snippet${s.snippets === 1 ? "" : "s"}`);
  if (s.mcp_servers)
    parts.push(`${s.mcp_servers} MCP server${s.mcp_servers === 1 ? "" : "s"}`);
  const body = parts.length > 0 ? parts.join(" · ") : "0 records";
  return `Imported ${body}. Reloading…`;
}

/* ───────────────── Erase & Reset confirmation dialog ─────────────────
 *
 * Two-step destructive UI:
 *   1. User picks a mode — "my data only" vs "factory reset" — via a
 *      pair of card-style radio options.
 *   2. User types YES (case-insensitive "yes" accepted) to unlock the
 *      red "Erase" button. Both the radio choice and the text input
 *      reset on every re-open so a closed-then-reopened dialog always
 *      starts clean.
 * ─────────────────────────────────────────────────────────────────── */

type EraseMode = "user-data" | "factory-reset";

function EraseDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (successMessage: string) => void;
}) {
  const [mode, setMode] = useState<EraseMode>("user-data");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the dialog is opened — never carry state across
  // mount/unmount cycles for a destructive action.
  useEffect(() => {
    if (open) {
      setMode("user-data");
      setConfirmText("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const armed = confirmText.trim().toUpperCase() === "YES";

  const handleConfirm = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "user-data") {
        await wipeUserData();
        onDone("All chats, spaces, snippets, and MCP servers deleted. Reloading…");
      } else {
        await factoryReset();
        onDone("Loach has been reset to factory defaults. Reloading…");
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-lg gap-5">
        <div>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Erase &amp; Reset
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] text-foreground/60">
            Choose what to erase. Nothing happens until you type{" "}
            <span className="font-mono font-semibold text-foreground/80">YES</span>{" "}
            and press the red button.
          </DialogDescription>
        </div>

        <div className="space-y-2.5">
          <EraseOption
            selected={mode === "user-data"}
            onClick={() => setMode("user-data")}
            title="Remove my data"
            body={
              <>
                Delete all <strong>chats</strong>, <strong>spaces</strong>,{" "}
                <strong>snippets</strong>, and <strong>MCP servers</strong>.
                Keeps your settings (theme, provider URLs, system prompt) and
                your stored OpenAI API key.
              </>
            }
          />
          <EraseOption
            selected={mode === "factory-reset"}
            onClick={() => setMode("factory-reset")}
            title="Factory reset"
            emphasis="danger"
            body={
              <>
                Everything above, <strong>plus</strong> all app settings and
                your stored <strong>OpenAI API key</strong>. The app will
                look like a fresh install.
              </>
            }
          />
        </div>

        <div>
          <Label htmlFor="erase-confirm" className="text-[12px]">
            Type <span className="font-mono font-semibold">YES</span> to confirm
          </Label>
          <Input
            id="erase-confirm"
            className="mt-1.5 font-mono"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="YES"
            disabled={busy}
          />
        </div>

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!armed || busy}
            onClick={handleConfirm}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Erasing…
              </>
            ) : mode === "factory-reset" ? (
              <>
                <RotateCcw className="h-3.5 w-3.5" />
                Factory reset
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                Erase my data
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EraseOption({
  selected,
  onClick,
  title,
  body,
  emphasis,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body: React.ReactNode;
  emphasis?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group flex w-full items-start gap-3 rounded-2xl border-2 p-3.5 text-left transition-all",
        selected
          ? emphasis === "danger"
            ? "border-destructive bg-destructive/[0.07]"
            : "border-primary bg-primary/[0.06]"
          : "border-foreground/10 hover:border-foreground/25 hover:bg-foreground/[0.02]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-all",
          selected
            ? emphasis === "danger"
              ? "border-destructive"
              : "border-primary"
            : "border-foreground/30 group-hover:border-foreground/50",
        )}
        aria-hidden
      >
        {selected && (
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              emphasis === "danger" ? "bg-destructive" : "bg-primary",
            )}
          />
        )}
      </span>
      <div className="min-w-0">
        <div
          className={cn(
            "text-[13px] font-semibold",
            selected && emphasis === "danger"
              ? "text-destructive"
              : "text-foreground",
          )}
        >
          {title}
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/60">
          {body}
        </p>
      </div>
    </button>
  );
}
