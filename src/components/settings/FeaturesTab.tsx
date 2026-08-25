//! Settings -> Features: the opt-in behaviours (memory, temporal awareness, snippet template vars).

import { Brain, ChevronDown, ChevronRight, Clock, MemoryStick } from "lucide-react";
import { KeepAliveSwitch } from "./switches";
import { Label } from "@/components/ui/label";
import { SectionTitle } from "./shared";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { useState } from "react";

export function FeaturesTab() {
  const settings = useSettingsStore();
  const [templateVarsOpen, setTemplateVarsOpen] = useState(false);
  return (
    <>
                <SectionTitle>Features</SectionTitle>

                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Label className="flex items-center gap-1.5">
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
                    <Switch
                      checked={settings.thinking_default}
                      onCheckedChange={(next) =>
                        settings.update("thinking_default", next)
                      }
                      className="shrink-0"
                      aria-label={
                        settings.thinking_default
                          ? "Disable LLM Thinking by default"
                          : "Enable LLM Thinking by default"
                      }
                    />
                  </div>
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
                        Enable to inject current date, time, weekday and
                        timezone into every chat so models can answer questions
                        like "What day is it today?".
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
                      <Label className="flex items-center gap-1.5">
                        <MemoryStick className="h-3.5 w-3.5 text-foreground/60" />
                        Low VRAM mode
                      </Label>
                      <p className="mt-1 text-[11px] text-foreground/50">
                        Force Ollama into low-VRAM mode for every chat for
                        smaller batches and leaner KV cache. This setting
                        overrides the per-chat Low&nbsp;VRAM toggle so you don't
                        have to flip it on each new session. Ignored by OpenAI
                        API providers.
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

    </>
  );
}
