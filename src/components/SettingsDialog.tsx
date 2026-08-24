import { useEffect, useState } from "react";
import {
  Archive,
  BookOpen,
  ChevronDown,
  Database,
  Info,
  Loader2,
  Lock,
  Palette,
  Play,
  Plug,
  RefreshCw,
  Server,
  Sparkles,
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";
import { isUpdateInstalling } from "@/lib/updater";
import { McpPanel } from "@/components/McpPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { UpdatesPanel } from "@/components/UpdatesPanel";
import { Logo } from "@/components/Logo";
import { AppearanceTab } from "@/components/settings/AppearanceTab";
import { ArchivePanel } from "@/components/settings/ArchivePanel";
import { FeaturesTab } from "@/components/settings/FeaturesTab";
import { GeneralTab } from "@/components/settings/GeneralTab";
import {
  SectionTitle,
  useBufferedSetting,
} from "@/components/settings/shared";
import {
  TOOL_TOGGLES,
  ToolToggleRow,
} from "@/components/settings/ToolToggles";
import {
  ConnTestResult,
  type ConnTestState,
} from "@/components/settings/ConnTest";
import { DataPanel } from "@/components/settings/DataPanel";
import { Switch } from "@/components/ui/switch";
import {
  openExternal,
  ollamaListModels,
  openaiListModels,
} from "@/lib/tauri";

/** Keys of `Settings` whose value is a boolean — the ones a Switch can drive. */
const API_BASE_URL_PRESETS: ReadonlyArray<{ label: string; url: string }> = [
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "llama.cpp (llama-server)", url: "http://localhost:8080/v1" },
  { label: "LM Studio", url: "http://localhost:1234/v1" },
  { label: "vLLM", url: "http://localhost:8000/v1" },
  { label: "LiteLLM", url: "http://localhost:4000" },
];

const GITHUB_URL = "https://github.com/ztcs-software/loach";
const DOCS_URL = "https://docs.loach.dev";

/* Brand mark. lucide dropped its brand icons in v1 — one glyph doesn't
 * justify a dependency, so the path lives here next to its button. */
const GITHUB_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

const NAV = [
  { value: "general", label: "General", icon: User },
  { value: "providers", label: "Providers", icon: Server },
  { value: "features", label: "Features", icon: Sparkles },
  { value: "tools", label: "Tools", icon: Wrench },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "mcp", label: "MCP", icon: Plug },
  { value: "archive", label: "Archive", icon: Archive },
  { value: "data", label: "Data", icon: Database },
  { value: "security", label: "Security", icon: Lock },
  { value: "updates", label: "Updates", icon: RefreshCw },
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
  const [ollamaTest, setOllamaTest] = useState<ConnTestState>({ kind: "idle" });
  const [openaiTest, setOpenaiTest] = useState<ConnTestState>({ kind: "idle" });

  // Clear transient state when the dialog closes. Radix unmounts only the
  // CONTENT, so these live on for the app's lifetime: a typed-but-never-saved
  // API key stayed in memory and re-rendered into the password field on every
  // future open, and days-old connection-test cards reappeared as if fresh.
  useEffect(() => {
    if (open) return;
    setPendingKey("");
    setOllamaTest({ kind: "idle" });
    setOpenaiTest({ kind: "idle" });
  }, [open]);

  // Free-text settings are buffered locally and persisted on a pause / blur
  // / unmount rather than on every keystroke — see `useBufferedSetting`.
  const ollamaUrlField = useBufferedSetting(
    "ollama_base_url",
    settings.ollama_base_url,
    settings.update,
    open,
  );
  const openaiUrlField = useBufferedSetting(
    "openai_base_url",
    settings.openai_base_url,
    settings.update,
    open,
  );

  const runOllamaTest = async () => {
    setOllamaTest({ kind: "testing" });
    try {
      const models = await ollamaListModels(settings.ollama_base_url);
      setOllamaTest({ kind: "ok", modelCount: models.length });
    } catch (e) {
      setOllamaTest({
        kind: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const runOpenAITest = async () => {
    setOpenaiTest({ kind: "testing" });
    try {
      const models = await openaiListModels(settings.openai_base_url);
      setOpenaiTest({ kind: "ok", modelCount: models.length });
    } catch (e) {
      setOpenaiTest({
        kind: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Refuse to close mid-install. The download can't be stopped and the
        // app relaunches itself when it lands, so dismissing here would hide
        // the progress bar and then restart the app out from under someone
        // who thought they'd cancelled — the same reason the launch-time
        // update dialog blocks its own dismissal.
        if (!next && isUpdateInstalling()) return;
        setOpen(next);
      }}
    >
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
          onValueChange={(v) => {
            // Switching tabs unmounts UpdatesPanel, which would strand an
            // in-flight install with no visible progress. Same guard as the
            // dialog's own close.
            if (isUpdateInstalling()) return;
            setSettingsTab(v as typeof settingsTab);
          }}
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
            <div className="flex-1 overflow-y-auto px-8 pb-8 pt-6 pr-14 [scrollbar-gutter:stable]">
              {/* pr-14 keeps the scrolling content clear of the dialog's absolute close X */}

              <TabsContent value="providers" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Providers</SectionTitle>

                <div>
                  <Label>Ollama base URL</Label>
                  <Input
                    className="mt-1.5"
                    value={ollamaUrlField.value}
                    onChange={(e) => {
                      ollamaUrlField.onChange(e.target.value);
                      if (ollamaTest.kind !== "idle") setOllamaTest({ kind: "idle" });
                    }}
                    onBlur={ollamaUrlField.onBlur}
                    placeholder="http://localhost:11434"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Auto-detected on app launch. Leave default unless you run Ollama remotely.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runOllamaTest()}
                      disabled={ollamaTest.kind === "testing"}
                      className="gap-1.5"
                    >
                      {ollamaTest.kind === "testing" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plug className="h-3.5 w-3.5" />
                      )}
                      Test connection
                    </Button>
                  </div>
                  {ollamaTest.kind !== "idle" && ollamaTest.kind !== "testing" && (
                    <ConnTestResult className="mt-2.5" result={ollamaTest} providerLabel="Ollama" />
                  )}
                </div>

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label className="flex items-center gap-1.5">
                        <Play className="h-3.5 w-3.5 text-foreground/60" />
                        Auto-launch Ollama
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Start Ollama when Loach opens, if it isn't already
                        running. Only works when the base URL above points at
                        this computer. You can always start it by hand from the
                        model picker.
                      </p>
                    </div>
                    <Switch
                      checked={settings.ollama_auto_launch}
                      onCheckedChange={(next) =>
                        settings.update("ollama_auto_launch", next)
                      }
                      className="shrink-0"
                      aria-label={
                        settings.ollama_auto_launch
                          ? "Disable auto-launching Ollama"
                          : "Enable auto-launching Ollama"
                      }
                    />
                  </div>
                </div>

                <Separator />

                <div>
                  <Label>API base URL</Label>
                  <div className="relative mt-1.5">
                    <Input
                      className="pr-10"
                      value={openaiUrlField.value}
                      onChange={(e) => {
                        openaiUrlField.onChange(e.target.value);
                        if (openaiTest.kind !== "idle") setOpenaiTest({ kind: "idle" });
                      }}
                      onBlur={openaiUrlField.onBlur}
                      placeholder="https://api.openai.com/v1"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label="Choose a preset endpoint"
                          title="Preset endpoints"
                          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/25"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-72">
                        {API_BASE_URL_PRESETS.map((p) => (
                          <DropdownMenuItem
                            key={p.label}
                            onSelect={() => {
                              settings.update("openai_base_url", p.url);
                              if (openaiTest.kind !== "idle") setOpenaiTest({ kind: "idle" });
                            }}
                            className="flex flex-col items-start gap-0.5"
                          >
                            <span className="text-[13px]">{p.label}</span>
                            <span className="font-mono text-[11px] text-foreground/55">
                              {p.url}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Set an OpenAI-compatible API endpoint.
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
                          if (openaiTest.kind !== "idle") setOpenaiTest({ kind: "idle" });
                        } catch (e) {
                          // Keep `pendingKey` (it's only cleared on success
                          // above) so the user can retry without retyping.
                          useToastStore.getState().push({
                            kind: "error",
                            title: "Couldn't save API key",
                            body: e instanceof Error ? e.message : String(e),
                          });
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
                            if (openaiTest.kind !== "idle") setOpenaiTest({ kind: "idle" });
                          } catch (e) {
                            useToastStore.getState().push({
                              kind: "error",
                              title: "Couldn't clear API key",
                              body: e instanceof Error ? e.message : String(e),
                            });
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
                    Leave blank for local servers (llama.cpp, LM Studio, vLLM).
                    Only required for hosted providers like OpenAI.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runOpenAITest()}
                      disabled={openaiTest.kind === "testing" || pendingKey.length > 0}
                      className="gap-1.5"
                      title={
                        pendingKey.length > 0
                          ? "Save the key first, then test."
                          : undefined
                      }
                    >
                      {openaiTest.kind === "testing" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plug className="h-3.5 w-3.5" />
                      )}
                      Test connection
                    </Button>
                    {pendingKey.length > 0 && (
                      <span className="text-[11px] text-foreground/55">
                        Save the key first, then test.
                      </span>
                    )}
                  </div>
                  {openaiTest.kind !== "idle" && openaiTest.kind !== "testing" && (
                    <ConnTestResult className="mt-2.5" result={openaiTest} providerLabel="OpenAI" />
                  )}
                </div>

              </TabsContent>

              <TabsContent value="general" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <GeneralTab open={open} />
              </TabsContent>

              <TabsContent value="features" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <FeaturesTab />
              </TabsContent>

              <TabsContent value="tools" className="mt-0 space-y-6 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Tools</SectionTitle>
                <p className="text-[13px] text-foreground/55">
                  Additional capabilities Loach can offer for the models.
                </p>

                {TOOL_TOGGLES.map((tool) => (
                  <ToolToggleRow key={tool.key} tool={tool} />
                ))}
              </TabsContent>

              <TabsContent value="mcp" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
                <McpPanel />
              </TabsContent>

              <TabsContent value="appearance" className="mt-0 space-y-7 focus-visible:ring-0 focus-visible:ring-offset-0">
                <AppearanceTab />
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
                  this machine excluding API keys saved in credentials manager.
                </p>
                <DataPanel />
              </TabsContent>

              <TabsContent value="security" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Security</SectionTitle>
                <div className="mt-5">
                  <SecurityPanel />
                </div>
              </TabsContent>

              <TabsContent value="updates" className="mt-0 space-y-5 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>Updates</SectionTitle>
                <UpdatesPanel />
              </TabsContent>

              <TabsContent value="about" className="mt-0 space-y-5 focus-visible:ring-0 focus-visible:ring-offset-0">
                <SectionTitle>About</SectionTitle>
                <div className="flex items-center gap-4">
                  <Logo size={56} ariaHidden />
                  <div className="flex items-baseline gap-3">
                    <h3 className="text-2xl font-semibold tracking-tight">Loach</h3>
                    <span className="font-mono text-xs text-foreground/50">
                      v{__APP_VERSION__}
                    </span>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-foreground/75">
                  A native AI desktop workspace for local and remote LLMs with Ollama and OpenAI-compatible API support.
                </p>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void openExternal(GITHUB_URL)}
                    className="gap-2"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d={GITHUB_PATH} />
                    </svg>
                    GitHub
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void openExternal(DOCS_URL)}
                    className="gap-2"
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



/** Inline success / failure card for the Providers "Test connection"
 *  buttons. Mirrors `McpPanel`'s TestResultCard styling so users see the
 *  same visual language no matter which connection they're checking. */
