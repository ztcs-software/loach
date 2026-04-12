import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
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

export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const settings = useSettingsStore();

  const [pendingKey, setPendingKey] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl !rounded-3xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure providers, system prompts, and appearance.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="providers">
          <TabsList>
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="prompt">System prompt</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <TabsContent value="providers" className="space-y-5 pt-2">
            <div>
              <Label>Ollama base URL</Label>
              <Input
                className="mt-1.5"
                value={settings.ollama_base_url}
                onChange={(e) => settings.update("ollama_base_url", e.target.value)}
                placeholder="http://localhost:11434"
              />
              <p className="mt-1.5 text-[11px] text-foreground/45">
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
              <p className="mt-1.5 text-[11px] text-foreground/45">
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
              <p className="mt-1.5 text-[11px] text-foreground/45">
                Stored in your OS credential manager (Windows Credential Manager / Linux Secret Service).
                Never written to disk in plain text.
              </p>
            </div>
          </TabsContent>
          <TabsContent value="prompt" className="space-y-3 pt-2">
            <Label>Global system prompt</Label>
            <Textarea
              rows={10}
              value={settings.global_system_prompt}
              onChange={(e) =>
                settings.update("global_system_prompt", e.target.value)
              }
              placeholder="You are a helpful assistant…"
            />
            <p className="text-[11px] text-foreground/45">
              Applied to every new chat. Individual chats can override this from the parameter panel.
            </p>
          </TabsContent>
          <TabsContent value="appearance" className="space-y-5 pt-2">
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
              <p className="mt-1.5 text-[11px] text-foreground/45">
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
              <p className="mt-1.5 text-[11px] text-foreground/45">
                Gradient = animated mesh blur. Solid = a single flat surface that
                follows the active theme.
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
