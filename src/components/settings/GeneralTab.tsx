//! Settings -> General: identity, default model, custom instructions, and the app-wide toggles.

import { ChevronDown, ChevronRight } from "lucide-react";
import { DEFAULT_TONE_ID, TONES } from "@/lib/tones";
import { DefaultModelPicker, DefaultModelPreloadToggle } from "./DefaultModelPicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionTitle, useBufferedSetting } from "./shared";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { useState } from "react";

export function GeneralTab({ open }: { open: boolean }) {
  const settings = useSettingsStore();
  const [tonesInfoOpen, setTonesInfoOpen] = useState(false);
  const userNameField = useBufferedSetting("user_name", settings.user_name, settings.update, open);
  const systemPromptField = useBufferedSetting(
    "global_system_prompt",
    settings.global_system_prompt,
    settings.update,
    open,
  );
  return (
    <>
                <SectionTitle>General</SectionTitle>

                <div>
                  <Label>Your name</Label>
                  <Input
                    className="mt-1.5"
                    value={userNameField.value}
                    onChange={(e) => userNameField.onChange(e.target.value)}
                    onBlur={userNameField.onBlur}
                    placeholder="Your name"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Optional. Available as{" "}
                    <span className="font-mono">{"{{USER_NAME}}"}</span> variable in custom instructions.
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
                  <DefaultModelPreloadToggle className="mt-3" />
                </div>

                <Separator />

                <div>
                  <Label>Custom instructions</Label>
                  <Textarea
                    rows={10}
                    className="mt-1.5 resize-none"
                    value={systemPromptField.value}
                    onChange={(e) => systemPromptField.onChange(e.target.value)}
                    onBlur={systemPromptField.onBlur}
                    placeholder="You are a helpful assistant…"
                  />
                  <p className="mt-1.5 text-[11px] text-foreground/50">
                    Applied to every new chat. Individual chats can override
                    this from per-chat or per-Space settings.
                  </p>
                </div>

                <Separator />

                <div>
                  <Label>Default tone</Label>
                  <p className="mt-1 mb-2.5 text-[11px] text-foreground/50">
                    Style modifier appended to the system prompt of every new
                    chat. Override per chat from the parameters sidebar.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {TONES.map((t) => {
                      const Icon = t.icon;
                      const active =
                        (settings.default_tone_id || DEFAULT_TONE_ID) === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() =>
                            settings.update("default_tone_id", t.id)
                          }
                          title={t.description}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
                            active
                              ? "border-foreground/70 bg-transparent font-bold text-foreground"
                              : "border-foreground/10 bg-foreground/[0.04] font-medium text-foreground/75 hover:border-foreground/25 hover:bg-foreground/[0.08] hover:text-foreground",
                          )}
                        >
                          <Icon className="h-3 w-3" />
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-[11px] leading-relaxed text-foreground/60">
                    <button
                      type="button"
                      onClick={() => setTonesInfoOpen((v) => !v)}
                      aria-expanded={tonesInfoOpen}
                      className="flex w-full items-center gap-1.5 text-left font-medium text-foreground/75 transition-colors hover:text-foreground"
                    >
                      {tonesInfoOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      What each tone does
                    </button>
                    {tonesInfoOpen && (
                      <ul className="mt-1.5 space-y-1 pl-5">
                        {TONES.map((t) => {
                          const Icon = t.icon;
                          return (
                            <li
                              key={t.id}
                              className="flex items-center gap-1.5"
                            >
                              <Icon className="h-3 w-3 shrink-0 text-foreground/55" />
                              <span className="font-medium text-foreground/75">
                                {t.label}
                              </span>
                              <span className="text-foreground/55">
                                — {t.shortDescription}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>

    </>
  );
}
