//! Settings -> General: the default-model picker and its preload toggle.
//! The picker mirrors chatStore.resolveDefaultModelChoice: both decode a
//! choice string ('recent' / 'provider:x' / 'model:p:id') with
//! `decodeModelChoice` (lib/modelChoice), not the dialog shell.

import type { ModelInfo } from "@/types";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { installedIn, resolveDefaultModelChoice, useChatStore } from "@/stores/chatStore";
import { useMemo } from "react";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { decodeModelChoice } from "@/lib/modelChoice";

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
 * Decoded by `decodeModelChoice` (lib/modelChoice), for this picker and
 * for `chatStore.resolveDefaultModelChoice` alike.
 *
 * The picker reads the live model list from `useModelsStore`; if it's
 * empty (e.g. Ollama unreachable, no OpenAI key) the model section just
 * collapses and the user is left with "recent" + per-provider choices,
 * which still works.
 * ─────────────────────────────────────────────────────────────────── */

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

export function DefaultModelPicker({ className }: { className?: string }) {
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

/* Toggle that asks the app to warm the resolved default model into VRAM at
 * startup. Only meaningful for local Ollama models — cloud providers have
 * no preload step — so the switch is forced off and disabled when the
 * resolved choice points at OpenAI (or at a not-yet-known model).
 *
 * The "is this Ollama?" decision mirrors the resolution in App.tsx and
 * `chatStore.resolveDefaultModelChoice`. We intentionally don't call the
 * resolver itself here just for the provider check — the choice encoding
 * is enough, and we only need the recent-pair fallback when `choice` is
 * `"recent"` (which `resolveDefaultModelChoice` handles by returning the
 * recent pair verbatim).
 */
export function DefaultModelPreloadToggle({ className }: { className?: string }) {
  const enabled = useSettingsStore((s) => s.default_model_preload);
  const choice = useSettingsStore((s) => s.default_model_choice);
  const recentProvider = useSettingsStore((s) => s.default_provider);
  const recentModel = useSettingsStore((s) => s.default_model);
  const update = useSettingsStore((s) => s.update);
  const sessions = useChatStore((s) => s.sessions);
  const models = useModelsStore((s) => s.models);

  const resolved = useMemo(
    () =>
      resolveDefaultModelChoice(
        choice,
        recentProvider,
        recentModel ?? "",
        sessions,
        installedIn(models),
      ),
    [choice, recentProvider, recentModel, sessions, models],
  );

  const isOllama = resolved.provider === "ollama" && !!resolved.model;

  return (
    <div className={className}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="setting-default-model-preload" className={cn(!isOllama && "text-foreground/55")}>
            Preload on startup
          </Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            {isOllama
              ? "Preload default model into VRAM on application launch."
              : "Only applies to local Ollama models. Pin the default to an Ollama model to enable."}
          </p>
        </div>
        <Switch id="setting-default-model-preload"
          checked={isOllama && enabled}
          disabled={!isOllama}
          onCheckedChange={(next) =>
            void update("default_model_preload", next)
          }
          className="shrink-0"
          aria-label="Preload the default model"
        />
      </div>
    </div>
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

