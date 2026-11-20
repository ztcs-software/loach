//! Settings -> Features: the opt-in behaviours (memory, temporal awareness, snippet template vars).

import {
  BookMarked,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
  Gauge,
  Image as ImageIcon,
} from "lucide-react";
import { ContextLengthSwitch, KeepAliveSwitch } from "./switches";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SectionTitle } from "./shared";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { GlobalMemoriesDialog } from "@/components/GlobalMemoriesDialog";
import { ImageScalingControl } from "@/components/ImageScalingControl";
import { DEFAULT_IMAGE_SCALING, resolveImageScaling } from "@/lib/imageScaling";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useEffect, useState } from "react";

export function FeaturesTab() {
  const settings = useSettingsStore();
  const [templateVarsOpen, setTemplateVarsOpen] = useState(false);
  const [globalMemoriesOpen, setGlobalMemoriesOpen] = useState(false);
  const globalMemories = useGlobalMemoryStore((s) => s.memories);
  const ensureGlobalLoaded = useGlobalMemoryStore((s) => s.ensureLoaded);
  // Warm the count on the button; a failed read just leaves it off.
  useEffect(() => {
    void ensureGlobalLoaded().catch(() => {});
  }, [ensureGlobalLoaded]);
  const globalCount = globalMemories?.length ?? 0;
  return (
    <>
                <SectionTitle>Features</SectionTitle>

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label htmlFor="setting-thinking-default" className="flex items-center gap-1.5">
                        <Brain className="h-3.5 w-3.5 text-foreground/60" />
                        Thinking
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Default state of the per-chat Thinking toggle for new
                        chats. Thinking switch in chat settings overrides this.
                        Only applies to thinking-capable Ollama models — OpenAI
                        API providers ignore this field.
                      </p>
                    </div>
                    <Switch id="setting-thinking-default"
                      checked={settings.thinking_default}
                      onCheckedChange={(next) =>
                        settings.update("thinking_default", next)
                      }
                      className="shrink-0"
                      aria-label="LLM Thinking by default"
                    />
                  </div>
                </div>

                <Separator />

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label htmlFor="setting-temporal-awareness" className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-foreground/60" />
                        Temporal awareness
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Enable to inject the current date, weekday and
                        timezone into every chat so models can answer questions
                        like "What day is it today?".
                      </p>
                    </div>
                    <Switch id="setting-temporal-awareness"
                      checked={settings.temporal_awareness}
                      onCheckedChange={(next) =>
                        settings.update("temporal_awareness", next)
                      }
                      className="shrink-0"
                      aria-label="Temporal awareness"
                    />
                  </div>
                  <div className="mt-3 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-[11px] leading-relaxed text-foreground/60">
                    <button
                      type="button"
                      onClick={() => setTemplateVarsOpen((v) => !v)}
                      aria-expanded={templateVarsOpen}
                      className="flex w-full items-center gap-1.5 text-left font-medium text-foreground/75 transition-colors hover:text-foreground"
                    >
                      {templateVarsOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      Template variables
                    </button>
                    {templateVarsOpen && (
                      <div className="mt-1.5 pl-5">
                        <p>
                          You may use these variables inside general custom
                          instructions or in Spaces, Snippets and per-chat.
                        </p>
                        <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                          <li>{"{{CURRENT_DATE}}"} → 2026-04-17</li>
                          <li>{"{{CURRENT_TIME}}"} → 14:32</li>
                          <li>{"{{CURRENT_WEEKDAY}}"} → Friday</li>
                          <li>{"{{CURRENT_DATETIME}}"} → 2026-04-17 14:32</li>
                          <li>{"{{CURRENT_TIMEZONE}}"} → Europe/Warsaw</li>
                        </ul>
                      </div>
                    )}
                  </div>
                </div>

                <Separator />

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label htmlFor="setting-global-memory" className="flex items-center gap-1.5">
                        <BookMarked className="h-3.5 w-3.5 text-foreground/60" />
                        Global memories
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Remember facts about you across all chats. After each
                        reply, an extra background request picks out what's
                        worth keeping. The facts go with every chat, cloud
                        providers included. Space chats keep their own memory
                        but see these too. Never used in Private Chat.
                      </p>
                    </div>
                    <Switch id="setting-global-memory"
                      checked={settings.global_memory_enabled}
                      onCheckedChange={(next) =>
                        settings.update("global_memory_enabled", next)
                      }
                      className="shrink-0"
                      aria-label="Global memories"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setGlobalMemoriesOpen(true)}
                    className="mt-3 rounded-xl"
                  >
                    <BookMarked className="h-3.5 w-3.5" />
                    Manage global memories
                    {globalCount > 0 ? ` (${globalCount})` : ""}
                  </Button>
                  <GlobalMemoriesDialog
                    open={globalMemoriesOpen}
                    onOpenChange={setGlobalMemoriesOpen}
                  />
                </div>

                <Separator />

                <div>
                  <Label className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-foreground/60" />
                    Keep model loaded
                  </Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    How long Ollama keeps the model in VRAM after a reply.
                    Longer means the next message skips the multi-second cold
                    reload, at the cost of pinning VRAM while idle.{" "}
                    <span className="font-medium text-foreground/70">
                      Always
                    </span>{" "}
                    keeps it resident until you unload it or quit Ollama.
                    Ignored by OpenAI API providers.
                  </p>
                  <KeepAliveSwitch
                    value={settings.ollama_keep_alive}
                    onChange={(next) =>
                      settings.update("ollama_keep_alive", next)
                    }
                  />
                </div>

                <Separator />

                <div>
                  <Label className="flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5 text-foreground/60" />
                    Default context length
                  </Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    How much of the conversation the model can see at once.
                    Bigger remembers more but uses more VRAM, and replies slow
                    down once it no longer fits. Ollama only; a chat, Space or
                    model with its own setting keeps it.
                  </p>
                  <ContextLengthSwitch
                    value={settings.default_num_ctx}
                    onChange={(next) =>
                      settings.update("default_num_ctx", next)
                    }
                  />
                </div>

                <Separator />

                <div>
                  <Label className="flex items-center gap-1.5">
                    <ImageIcon className="h-3.5 w-3.5 text-foreground/60" />
                    Image scaling
                  </Label>
                  <p className="mt-1 text-[11px] text-foreground/50">
                    How images are scaled down before they're sent to a model.
                    A full-size photo costs thousands of image tokens, and many
                    local models read it worse, not better. The original stays
                    in your chat. Spaces and chats can set their own; Library
                    images can too, in Settings&nbsp;→&nbsp;Library.
                  </p>
                  <div className="mt-3">
                    <ImageScalingControl
                      value={resolveImageScaling(settings.image_scaling)}
                      inherited={DEFAULT_IMAGE_SCALING}
                      onChange={(next) =>
                        next && settings.update("image_scaling", JSON.stringify(next))
                      }
                    />
                  </div>
                </div>

    </>
  );
}
