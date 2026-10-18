import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Download, Loader2, RefreshCw, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { ragReindex, setSetting } from "@/lib/tauri";
import { pullPercent, useLivePullFor } from "@/lib/usePullRuns";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/libraryStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ProviderId } from "@/types";
import { SectionTitle } from "./shared";

/** Embedding models worth suggesting on Ollama. Tags only — sizes change
 *  between releases, and the Models page shows the real ones. */
const OLLAMA_SUGGESTIONS: { tag: string; note: string }[] = [
  { tag: "embeddinggemma", note: "Small, multilingual — a good default" },
  { tag: "qwen3-embedding:0.6b", note: "Multilingual, strong on retrieval" },
  { tag: "bge-m3", note: "Multilingual, handles long passages" },
  { tag: "nomic-embed-text", note: "Compact, English-focused" },
];
const OPENAI_SUGGESTIONS: { tag: string; note: string }[] = [
  { tag: "text-embedding-3-small", note: "OpenAI — cheap and fast" },
  { tag: "text-embedding-3-large", note: "OpenAI — most accurate" },
];

/** Strip `:latest` so `nomic-embed-text` and `nomic-embed-text:latest`
 *  compare equal, as Ollama treats them. */
function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/:latest$/, "");
  return norm(a) === norm(b);
}

/**
 * Settings → Library: the embedding model behind search-by-meaning, and the
 * state of the retrieval index built over Library items and Space sources.
 */
export function LibraryTab() {
  const provider = useSettingsStore((s) => s.embedding_provider);
  const model = useSettingsStore((s) => s.embedding_model);
  const update = useSettingsStore((s) => s.update);
  const status = useLibraryStore((s) => s.indexStatus);
  const installed = useModelsStore((s) => s.models);
  const pullModel = useModelsStore((s) => s.pullModel);
  const { confirm } = useConfirm();
  const [draft, setDraft] = useState(model);
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => setDraft(model), [model]);

  const livePull = useLivePullFor(provider === "ollama" ? "ollama" : null, model || null);
  // A finished download of the chosen model: nudge the indexer right away
  // instead of waiting out its retry timer. Re-writing the setting wakes it.
  const wasPulling = useRef(false);
  useEffect(() => {
    if (wasPulling.current && !livePull && model) void setSetting("embedding_model", model);
    wasPulling.current = !!livePull;
  }, [livePull, model]);

  const isInstalled = (tag: string) =>
    installed.some((m) => m.provider === "ollama" && sameModel(m.id, tag));

  const choose = async (tag: string) => {
    setDraft(tag);
    await update("embedding_model", tag);
  };

  const download = async (tag: string) => {
    await choose(tag);
    await pullModel(tag);
  };

  const setProvider = async (p: ProviderId) => {
    if (p === provider) return;
    await update("embedding_provider", p);
    await update("embedding_model", "");
  };

  const rebuild = async () => {
    const ok = await confirm({
      title: "Rebuild the search index?",
      body: "Every source is embedded again with the current model. Search by keyword keeps working meanwhile.",
      confirmLabel: "Rebuild",
    });
    if (!ok) return;
    setRebuilding(true);
    try {
      await ragReindex();
    } finally {
      setRebuilding(false);
    }
  };

  const suggestions = provider === "ollama" ? OLLAMA_SUGGESTIONS : OPENAI_SUGGESTIONS;
  const installedEmbedders = installed.filter(
    (m) =>
      m.provider === "ollama" &&
      /embed|bge|e5|gte|minilm/i.test(m.id) &&
      !suggestions.some((s) => sameModel(s.tag, m.id)),
  );
  const pct = status && status.total > 0 ? Math.round((status.embedded / status.total) * 100) : 0;
  const ollamaMissing = provider === "ollama" && !!model && !isInstalled(model) && !livePull;

  return (
    <>
      <SectionTitle>Library</SectionTitle>
      <p className="text-[13px] text-foreground/55">
        Sources too big to give a model whole are searched instead, and only the relevant parts
        are sent. Keyword search works out of the box. An embedding model adds search by meaning:
        it finds passages that answer a question even when they don't share its words.
      </p>

      {/* Index status */}
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
                status?.error
                  ? "bg-amber-500/[0.12] text-amber-600 dark:text-amber-300"
                  : status?.model
                    ? "bg-primary/[0.12] text-primary"
                    : "bg-foreground/[0.06] text-foreground/55",
              )}
            >
              {status?.error ? (
                <AlertTriangle className="h-4 w-4" />
              ) : status?.model ? (
                <Sparkles className="h-4 w-4" />
              ) : (
                <Search className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground/85">
                {!status?.model
                  ? "Keyword search only"
                  : status.error
                    ? "Embedding is paused"
                    : status.embedded < status.total
                      ? "Indexing…"
                      : "Search by meaning and keyword"}
              </div>
              <p className="mt-0.5 text-xs text-foreground/50 [overflow-wrap:anywhere]">
                {!status
                  ? "Waiting for the indexer…"
                  : status.error
                    ? status.error
                    : status.model
                      ? `${status.embedded.toLocaleString()} of ${status.total.toLocaleString()} excerpts embedded`
                      : `${status.total.toLocaleString()} excerpts indexed for keyword search`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status?.error && (
              <Button
                size="sm"
                variant="outline"
                className="rounded-lg"
                onClick={() => void setSetting("embedding_model", model)}
              >
                Retry
              </Button>
            )}
            {status?.model && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 rounded-lg text-foreground/65"
                disabled={rebuilding}
                onClick={() => void rebuild()}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", rebuilding && "animate-spin")} />
                Rebuild
              </Button>
            )}
          </div>
        </div>
        {status?.model && status.total > 0 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", status.error ? "bg-amber-400/80" : "bg-primary/70")}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
        )}
      </div>

      {/* Model */}
      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium text-foreground/85">Embedding model</div>
          <p className="mt-0.5 text-xs text-foreground/50">
            Runs on your{" "}
            {provider === "ollama" ? "Ollama" : "OpenAI-compatible endpoint (Settings → Providers)"}.
            Changing it re-embeds every source in the background.
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-foreground/10 bg-foreground/[0.04] p-0.5">
          {(["ollama", "openai"] as ProviderId[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void setProvider(p)}
              className={cn(
                "rounded-[10px] px-3 py-1 text-xs font-medium transition-colors",
                provider === p ? "bg-foreground/[0.10] text-foreground" : "text-foreground/55 hover:text-foreground",
              )}
            >
              {p === "ollama" ? "Ollama" : "OpenAI-compatible"}
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void choose(draft.trim());
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={provider === "ollama" ? "e.g. embeddinggemma" : "e.g. text-embedding-3-small"}
            spellCheck={false}
            className="h-9"
          />
          <Button type="submit" size="sm" variant="outline" disabled={draft.trim() === model} className="rounded-lg">
            Use
          </Button>
          {model && (
            <Button type="button" size="sm" variant="ghost" className="rounded-lg text-foreground/60" onClick={() => void choose("")}>
              Turn off
            </Button>
          )}
        </form>
        {livePull && (
          <p className="flex items-center gap-1.5 text-xs text-foreground/55">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Downloading {model}
            {pullPercent(livePull) !== null && ` — ${pullPercent(livePull)}%`}
          </p>
        )}
        {ollamaMissing && (
          <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            {model} isn't installed in Ollama.
            <button type="button" onClick={() => void pullModel(model)} className="underline underline-offset-2">
              Download it
            </button>
          </p>
        )}

        <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.02]">
          {[...suggestions, ...installedEmbedders.map((m) => ({ tag: m.id, note: "Installed" }))].map((s) => {
            const active = !!model && sameModel(model, s.tag);
            const have = provider !== "ollama" || isInstalled(s.tag);
            return (
              <li key={s.tag} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-foreground/85">{s.tag}</div>
                  <div className="truncate text-[11.5px] text-foreground/45">{s.note}</div>
                </div>
                {active ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                    <Check className="h-3.5 w-3.5" />
                    In use
                  </span>
                ) : have ? (
                  <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs" onClick={() => void choose(s.tag)}>
                    Use
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 gap-1 rounded-lg text-xs" onClick={() => void download(s.tag)}>
                    <Download className="h-3 w-3" />
                    Download & use
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
