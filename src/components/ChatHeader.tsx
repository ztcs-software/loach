import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Sliders, RefreshCw, CircleAlert, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import {
  ollamaListModels,
  ollamaProbe,
  openaiListModels,
} from "@/lib/tauri";
import { Layers } from "lucide-react";
import type { ModelInfo, ProviderId, Session } from "@/types";

export function ChatHeader({ session }: { session: Session | undefined }) {
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const toggleParams = useUIStore((s) => s.toggleParams);
  const settings = useSettingsStore();

  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [openaiModels, setOpenaiModels] = useState<ModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const probe = await ollamaProbe(settings.ollama_base_url).catch(() => false);
        setOllamaUp(probe);
        if (probe) {
          const m = await ollamaListModels(settings.ollama_base_url).catch(() => []);
          setOllamaModels(m);
        } else {
          setOllamaModels([]);
        }
        if (settings.openai_key_set) {
          const m = await openaiListModels(settings.openai_base_url).catch(() => []);
          setOpenaiModels(m);
        }
      } finally {
        setLoading(false);
      }
    },
    [settings.ollama_base_url, settings.openai_base_url, settings.openai_key_set],
  );

  useEffect(() => {
    if (!settings.hydrated) return;
    refresh();
  }, [settings.hydrated, refresh]);

  const currentLabel = session
    ? `${session.model || "(no model)"} · ${session.provider}`
    : "Select a chat";

  const select = (provider: ProviderId, model: string) => {
    if (!session) return;
    setSessionModel(session.id, provider, model);
  };

  const spaceName = useSpaceStore((s) => {
    if (!session?.space_id) return null;
    return s.spaces.find((sp) => sp.id === session.space_id)?.name ?? null;
  });

  return (
    <div className="flex h-12 items-center justify-between border-b border-foreground/5 px-4">
      <div className="flex items-center gap-2 min-w-0">
        {spaceName && (
          <span className="flex items-center gap-1 rounded-full bg-foreground/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-foreground/60">
            <Layers className="h-3 w-3" />
            {spaceName}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={!session}>
            <Button
              variant="ghost"
              className="max-w-[420px] rounded-full text-foreground/80 hover:bg-foreground/10 hover:text-foreground"
            >
              <span className="truncate">{currentLabel}</span>
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[280px]">
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownMenuLabel className="p-0">Models</DropdownMenuLabel>
              <button
                className="rounded p-1 hover:bg-accent"
                onClick={(e) => {
                  e.preventDefault();
                  refresh();
                }}
                aria-label="Refresh models"
              >
                <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              </button>
            </div>
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
              <DropdownMenuItem disabled>
                {ollamaUp ? "No models installed" : "Not running"}
              </DropdownMenuItem>
            )}
            {ollamaModels.map((m) => (
              <DropdownMenuItem key={`ollama:${m.id}`} onSelect={() => select("ollama", m.id)}>
                {m.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>OpenAI</DropdownMenuLabel>
            {openaiModels.length === 0 && (
              <DropdownMenuItem disabled>
                {settings.openai_key_set ? "No models" : "API key not set"}
              </DropdownMenuItem>
            )}
            {openaiModels.slice(0, 30).map((m) => (
              <DropdownMenuItem key={`openai:${m.id}`} onSelect={() => select("openai", m.id)}>
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleParams}
          aria-label="Toggle parameters"
          className="rounded-xl text-foreground/70 hover:bg-foreground/10 hover:text-foreground"
        >
          <Sliders className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
