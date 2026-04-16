import { useState } from "react";
import {
  BookOpen,
  Github,
  Info,
  MessageSquareText,
  Palette,
  Server,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUIStore } from "@/stores/uiStore";
import { isTauri } from "@/lib/tauri";
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
  { value: "about", label: "About", icon: Info },
] as const;

export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
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
          defaultValue="providers"
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

              <TabsContent value="prompt" className="mt-0 space-y-4 focus-visible:ring-0 focus-visible:ring-offset-0">
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
