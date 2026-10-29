import { Check, ChevronDown, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProviderModels } from "@/lib/useProviderModels";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ProviderId } from "@/types";

/** What a snippet or Space without a pinned model shows — on its card, its
 *  meta chip and this picker alike. */
export const DEFAULT_MODEL_LABEL = "Default model";

/** Provider as the chat header's model button names it. */
function providerName(provider: ProviderId): string {
  return provider === "openai" ? "OpenAI" : "Ollama";
}

/**
 * Pin a model, or go back to the default, for a snippet or a Space. One
 * component for both so they read and behave the same: they had drifted
 * apart ("No default model" with a Clear button in the snippet dialog,
 * "Select a model" with a "Clear selection" item on a Space's page).
 */
export function DefaultModelPicker({
  provider,
  model,
  onChange,
}: {
  provider: ProviderId | null;
  model: string | null;
  /** `(null, null)` unpins — the snippet or Space uses the default again. */
  onChange: (provider: ProviderId | null, model: string | null) => void;
}) {
  // Slice the store: only the field that gates the API section. A full
  // `useSettingsStore()` subscription would re-render this picker on every
  // keystroke in the global SettingsDialog textareas.
  const openaiKeySet = useSettingsStore((s) => s.openai_key_set);
  const { ollamaModels, openaiModels, ollamaUp, loading, refresh } = useProviderModels();
  const pinned = !!(provider && model);
  const isCurrent = (p: ProviderId, id: string) => provider === p && model === id;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-11 w-full justify-between gap-2 rounded-xl border-foreground/10 bg-foreground/[0.03] px-4 text-left font-normal hover:bg-foreground/[0.06]"
        >
          {pinned ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-foreground/90">{model}</span>
              <span className="shrink-0 text-[11px] text-foreground/45">{providerName(provider!)}</span>
            </span>
          ) : (
            <span className="text-foreground/55">{DEFAULT_MODEL_LABEL}</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[--radix-dropdown-menu-trigger-width]">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Models</DropdownMenuLabel>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              refresh();
            }}
            className="rounded p-1 hover:bg-accent"
            aria-label="Refresh models"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange(null, null)}>
          <Check className={cn("h-4 w-4 shrink-0", pinned && "opacity-0")} />
          {DEFAULT_MODEL_LABEL}
          <span className="ml-auto pl-3 text-[11px] text-foreground/45">from Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5">
          {ollamaUp ? (
            <CircleCheck className="h-3 w-3 text-emerald-500" />
          ) : (
            <CircleAlert className="h-3 w-3 text-amber-500" />
          )}
          Ollama
        </DropdownMenuLabel>
        {ollamaModels.length === 0 && (
          <DropdownMenuItem disabled>{ollamaUp ? "No models installed" : "Not running"}</DropdownMenuItem>
        )}
        {ollamaModels.map((m) => (
          <DropdownMenuItem key={`ollama:${m.id}`} onSelect={() => onChange("ollama", m.id)}>
            <Check className={cn("h-4 w-4 shrink-0", !isCurrent("ollama", m.id) && "opacity-0")} />
            {m.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>API</DropdownMenuLabel>
        {openaiModels.length === 0 && (
          <DropdownMenuItem disabled>{openaiKeySet ? "No models" : "Not connected"}</DropdownMenuItem>
        )}
        {openaiModels.map((m) => (
          <DropdownMenuItem key={`openai:${m.id}`} onSelect={() => onChange("openai", m.id)}>
            <Check className={cn("h-4 w-4 shrink-0", !isCurrent("openai", m.id) && "opacity-0")} />
            {m.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
