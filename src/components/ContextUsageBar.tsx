import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Gauge, Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { parseOverrides, useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useDefaultNumCtx, useModelsStore } from "@/stores/modelsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSkillStore } from "@/stores/skillStore";
import { useMcpStore } from "@/stores/mcpStore";
import { selectMemoriesForPrompt } from "@/lib/memoryRules";
import { estimateChatSources } from "@/lib/sources";
import { chatToolsSize } from "@/lib/tauri";
import {
  DEFAULT_PARAMS,
  OPENAI_COMPAT_NUM_CTX,
  type ChatToolsSize,
  type GenerationParams,
  type Message,
  type SpaceFile,
} from "@/types";

/** Stands in for an OpenAI-compatible model's (absent) Modelfile defaults.
 *  Module-level so the store selector returns the same object each time. */
const OPENAI_COMPAT_DEFAULTS: Partial<GenerationParams> = { num_ctx: OPENAI_COMPAT_NUM_CTX };
import {
  baseSystemPrompt,
  computeContextUsage,
  formatTokens,
} from "@/lib/contextUsage";
import { cn } from "@/lib/utils";

// Stable empty array so the messages selector's no-messages branch keeps a
// constant reference (a fresh `[]` would re-fire the selector every render).
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_FILES: SpaceFile[] = [];

/**
 * Layer the same set of GenerationParams the chat send path uses, just
 * enough to find the effective `num_ctx` for the active session. Mirrors
 * the merge order in `chatStore.readSessionParams` minus the bits that
 * don't affect the context window (penalties, sampling, etc.).
 */
function effectiveParams(
  paramsJson: string | null,
  modelDefaults: Partial<GenerationParams> | undefined,
  spaceParamsJson: string | null,
  appNumCtx: number,
): GenerationParams {
  // Through the send's own guard: a wrong-typed `num_ctx` the send drops
  // (hand-edited, imported) overrode the model's window here.
  return {
    ...DEFAULT_PARAMS,
    num_ctx: appNumCtx,
    ...(modelDefaults ?? {}),
    ...parseOverrides(spaceParamsJson),
    ...parseOverrides(paramsJson),
  };
}

export function ContextUsageBar() {
  const session = useChatStore((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.id === s.activeSessionId)
      : undefined,
  );
  const messages = useChatStore((s) =>
    s.activeSessionId
      ? s.messages[s.activeSessionId] ?? EMPTY_MESSAGES
      : EMPTY_MESSAGES,
  );
  const globalSystemPrompt = useSettingsStore((s) => s.global_system_prompt);
  const isOllama = session?.provider === "ollama";
  const modelDefaults = useModelsStore((s) =>
    isOllama && session?.model
      ? s.modelDefaults[session.model]
      : session && !isOllama
        ? OPENAI_COMPAT_DEFAULTS
        : undefined,
  );
  // The model's trained window, when Ollama reports it: Expand stops there,
  // as the default does — Ollama clamps a bigger `num_ctx` on load.
  const modelContextMax = useModelsStore((s) =>
    isOllama && session?.model ? s.modelContextMax[session.model] : undefined,
  );
  const space = useSpaceStore((s) =>
    session?.space_id ? s.spaces.find((x) => x.id === session.space_id) : null,
  );
  // Counted only while Workspace files is on — the backend drops the
  // folder, and with it its instructions file, when the switch is off.
  const workspaceToolsEnabled = useSettingsStore((s) => s.workspace_tool_enabled);
  const projectInstructions = useChatStore((s) =>
    workspaceToolsEnabled && s.activeSessionId
      ? (s.workspaceInstructions[s.activeSessionId] ?? null)
      : null,
  );
  // The memory lists the send prepends: global memory when it's on, and the
  // Space's own — each cut the way the send cuts it. Counted from what the
  // stores have loaded; a list not loaded yet counts as empty.
  const globalMemoryOn = useSettingsStore((s) => s.global_memory_enabled);
  const globalMemories = useGlobalMemoryStore((s) => s.memories);
  const spaceMemories = useSpaceStore((s) =>
    session?.space_id ? s.spaceMemories[session.space_id] : undefined,
  );
  const memoryText = useMemo(() => {
    const rows = [
      ...(globalMemoryOn && globalMemories ? selectMemoriesForPrompt(globalMemories) : []),
      ...(spaceMemories ? selectMemoriesForPrompt(spaceMemories) : []),
    ];
    return rows.length > 0 ? rows.map((m) => `- ${m.content}`).join("\n") : null;
  }, [globalMemoryOn, globalMemories, spaceMemories]);
  // Sources: the Space's own uploads and the Library items linked to the
  // Space or to this chat. Loaded here if nothing else has yet, so the bar
  // counts them from the first render of a chat.
  const spaceFiles = useSpaceStore((s) =>
    session?.space_id ? s.spaceFiles[session.space_id] : undefined,
  );
  const loadSpaceFiles = useSpaceStore((s) => s.loadSpaceFiles);
  const libraryItems = useLibraryStore((s) => s.items);
  const libraryDatasets = useLibraryStore((s) => s.datasets);
  const librarySources = useLibraryStore((s) => s.sources);
  const ensureSources = useLibraryStore((s) => s.ensureSources);
  const spaceId = session?.space_id ?? null;
  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (spaceId && !useSpaceStore.getState().spaceFiles[spaceId]) {
      void loadSpaceFiles(spaceId).catch(() => undefined);
    }
    if (spaceId) void ensureSources("space", spaceId).catch(() => undefined);
    if (sessionId) void ensureSources("session", sessionId).catch(() => undefined);
  }, [spaceId, sessionId, loadSpaceFiles, ensureSources]);
  // The tool definitions every request carries, sized by the backend — it
  // alone builds the catalogue. Asked again when the chat, its folder or any
  // setting changes (most tools are a Settings switch), and once a turn in
  // it ends: the send fills the MCP cache, and may have loaded a skill.
  const workspaceRoot = session?.workspace_root ?? null;
  const settings = useSettingsStore((s) => s);
  const streamingHere = useChatStore(
    (s) => !!sessionId && s.streamingSessionId === sessionId,
  );
  // A skill loaded or unloaded with `/skill` changes what the send carries,
  // as do a skill switched off or imported, an MCP server added or switched
  // off, and the MCP tools the typing warm-up has listed.
  const loadedSkills = useSkillStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const skillCatalog = useSkillStore((s) => s.catalog);
  const mcpServers = useMcpStore((s) => s.servers);
  const mcpWarmedAt = useMcpStore((s) => s.toolsWarmedAt);
  const [tools, setTools] = useState<{ sessionId: string; size: ChatToolsSize } | null>(null);
  useEffect(() => {
    if (!sessionId || streamingHere) return;
    let live = true;
    chatToolsSize(sessionId).then(
      (size) => {
        if (live) setTools({ sessionId, size });
      },
      // Display only: a failed read leaves the tools uncounted.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [sessionId, workspaceRoot, settings, streamingHere, loadedSkills, skillCatalog, mcpServers, mcpWarmedAt]);
  const toolsSize = tools?.sessionId === sessionId ? tools.size : null;
  const compactingSessionId = useChatStore((s) => s.compactingSessionId);
  const compactContext = useChatStore((s) => s.compactContext);
  const setSessionParams = useChatStore((s) => s.setSessionParams);

  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Closed from inside (Escape, its X), focus goes back to the trigger: it
  // unmounted with the popover, and fell to <body>.
  const close = useCallback(() => {
    const inside = popoverRef.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (inside) triggerRef.current?.focus();
  }, []);

  // Close popover on outside click / Esc. Same pattern as the textarea
  // context menu in ChatInput.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const pop = popoverRef.current;
      const trig = triggerRef.current;
      if (pop && e.target instanceof Node && pop.contains(e.target)) return;
      if (trig && e.target instanceof Node && trig.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  // Focus moves in when it opens.
  useEffect(() => {
    if (open) popoverRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);

  const appNumCtx = useDefaultNumCtx(session?.provider, session?.model);
  const params = useMemo(
    () =>
      effectiveParams(
        session?.params_json ?? null,
        modelDefaults,
        space?.default_params_json ?? null,
        appNumCtx,
      ),
    [session?.params_json, modelDefaults, space?.default_params_json, appNumCtx],
  );

  // The system prompt the request will actually send is the Space's
  // instructions in a Space, else the per-session value when set, otherwise
  // the global default, with any compaction summary in front — the same
  // pick the send makes. Sources (Space uploads, Library items) are counted
  // separately below at what the send will spend on them. The bar is a
  // hint, not a billing tool — close enough for sizing decisions. The one
  // backend-appended layer that can be big is the workspace's instructions
  // file (LOACHFILE.md, CLAUDE.md or AGENTS.md), so that is counted from
  // the store's last read of it.
  const effectiveSystemPrompt = baseSystemPrompt(
    session?.system_prompt ?? null,
    globalSystemPrompt,
    // In a Space its instructions replace the per-chat prompt, as on send.
    space?.instructions.trim() ?? "",
  );
  const sources = useMemo(
    () =>
      session
        ? estimateChatSources({
            session,
            spaceFiles: spaceFiles ?? EMPTY_FILES,
            spaceMode: space?.retrieval_mode,
            numCtx: params.num_ctx ?? DEFAULT_PARAMS.num_ctx ?? 8192,
          })
        : { tokens: 0, mode: null, count: 0 },
    // The library selectors are listed so the estimate follows edits to
    // the items, datasets and links it reads from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, spaceFiles, space?.retrieval_mode, params.num_ctx, libraryItems, libraryDatasets, librarySources],
  );

  // Defer the recompute: `messages` changes identity on every streaming flush
  // and computeContextUsage rescans the whole transcript. useDeferredValue lets
  // React skip intermediate values during a burst and recompute when idle —
  // and it always catches up to the final value once streaming stops, so the
  // bar can't end stale (the failure mode a leading-edge timer throttle has).
  const deferredMessages = useDeferredValue(messages);
  const usage = useMemo(
    () =>
      computeContextUsage(
        deferredMessages,
        effectiveSystemPrompt,
        params,
        projectInstructions?.text ?? null,
        memoryText,
        sources.tokens,
        toolsSize?.chars ?? 0,
        toolsSize?.skills_chars ?? 0,
      ),
    [
      deferredMessages,
      effectiveSystemPrompt,
      params,
      projectInstructions,
      memoryText,
      sources.tokens,
      toolsSize?.chars,
      toolsSize?.skills_chars,
    ],
  );

  // Don't show the bar before the user has any conversation to measure —
  // an empty chat with 0 tokens used adds noise without informing.
  if (!session || usage.messageCount === 0) return null;

  const isCompacting = compactingSessionId === session.id;
  const expandedSize = modelContextMax ? Math.min(usage.total * 2, modelContextMax) : usage.total * 2;
  const pct = Math.round(usage.ratio * 100);
  const tone =
    usage.ratio >= 0.9
      ? "danger"
      : usage.ratio >= 0.7
        ? "warn"
        : "ok";

  const trackTint =
    tone === "danger"
      ? "bg-rose-500/80"
      : tone === "warn"
        ? "bg-amber-400/80"
        : "bg-primary/70";

  const labelTint =
    tone === "danger"
      ? "text-rose-700 dark:text-rose-300"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : "text-foreground/55";

  return (
    <div className="relative mx-auto mt-1.5 w-full max-w-3xl">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context usage: ${formatTokens(usage.used)} of ${formatTokens(usage.total)} tokens. Click for details.`}
        title="Context usage — click to see breakdown"
        className={cn(
          "group flex w-full items-center gap-2 rounded-full px-2 py-1 text-[10.5px] transition-colors",
          "hover:bg-foreground/[0.05]",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        )}
      >
        <Gauge
          className={cn(
            "h-3 w-3 shrink-0 transition-colors",
            labelTint,
            "group-hover:text-foreground/75",
          )}
        />
        <span
          className={cn(
            "tabular-nums transition-colors",
            labelTint,
            "group-hover:text-foreground/75",
          )}
        >
          {formatTokens(usage.used)} / {formatTokens(usage.total)}
        </span>
        <div
          className="relative h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.07]"
          aria-hidden
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width,background-color] duration-300",
              trackTint,
            )}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
        <span
          className={cn(
            "tabular-nums transition-colors",
            labelTint,
            "group-hover:text-foreground/75",
          )}
        >
          {pct}%
        </span>
      </button>

      {open && (
        <ContextUsagePopover
          popoverRef={popoverRef}
          usage={usage}
          toolsCount={toolsSize?.count ?? 0}
          sourcesLabel={
            sources.count > 0
              ? `Sources (${sources.count}${sources.mode === "retrieval" ? ", excerpts" : ""})`
              : null
          }
          instructionsFile={projectInstructions?.file ?? null}
          compacting={isCompacting}
          onCompact={() => void compactContext(session.id)}
          expandedSize={expandedSize}
          // OpenAI-compatible servers ignore `num_ctx`: "expanding" there
          // would only change Loach's own estimate, not the model's window.
          // Nor past the model's own window.
          canExpand={isOllama && expandedSize > usage.total}
          onExpand={() => {
            // Merge into the EXISTING per-chat override, not the merged
            // stack. `params` is DEFAULT_PARAMS + model defaults + space
            // layer + overrides, and `setSessionParams` stringifies whatever
            // it's handed straight into `params_json` — so writing the merged
            // object froze the model's Modelfile values and the Space's
            // pinned params into this chat as if the user had set them. A
            // later Modelfile edit or Space change then silently stopped
            // applying here. Only `num_ctx` is the user's intent.
            // Guarded like the send reads it: unchecked keys were written back.
            void setSessionParams(session.id, {
              ...parseOverrides(session.params_json),
              num_ctx: expandedSize,
            } as GenerationParams);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

interface PopoverProps {
  usage: ReturnType<typeof computeContextUsage>;
  /** How many tool definitions `usage.toolsTokens` covers. */
  toolsCount: number;
  /** Row label for the sources line, or null when the chat has none. */
  sourcesLabel: string | null;
  /** The file the project instructions came from, or null when none. */
  instructionsFile: string | null;
  compacting: boolean;
  onCompact: () => void;
  /** False for OpenAI-compatible chats, whose servers ignore `num_ctx`. */
  canExpand: boolean;
  onExpand: () => void;
  expandedSize: number;
  onClose: () => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
}

const ContextUsagePopover = ({
  usage,
  toolsCount,
  sourcesLabel,
  instructionsFile,
  compacting,
  onCompact,
  canExpand,
  onExpand,
  expandedSize,
  onClose,
  popoverRef,
}: PopoverProps) => {
  const pct = Math.round(usage.ratio * 100);
  // Enable Compact when usage is at least ~25% and there's meaningful
  // history. Below that the round-trip costs more than it saves; the
  // explicit threshold prevents the user from wasting a request on a
  // chat with three messages in it.
  const canCompact = usage.messageCount >= 6 && usage.ratio >= 0.25;
  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Context usage details"
      className={cn(
        "glass-panel absolute bottom-full left-1/2 z-30 mb-2 w-[320px] -translate-x-1/2",
        "rounded-2xl p-3.5 text-foreground shadow-xl",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          <Gauge className="h-3.5 w-3.5 text-foreground/65" />
          <span>Context usage</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 -mt-1 grid h-6 w-6 place-items-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[20px] font-semibold tabular-nums tracking-tight">
            {pct}%
          </span>
          <span className="text-[11px] tabular-nums text-foreground/55">
            {formatTokens(usage.used)} / {formatTokens(usage.total)} tokens
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              usage.ratio >= 0.9
                ? "bg-rose-500/80"
                : usage.ratio >= 0.7
                  ? "bg-amber-400/80"
                  : "bg-primary/70",
            )}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      </div>

      <dl className="mt-3 space-y-1 text-[11.5px]">
        <Row
          label="System prompt"
          value={formatTokens(usage.systemPromptTokens)}
        />
        {usage.toolsTokens > 0 && (
          <Row label={`Tools (${toolsCount})`} value={formatTokens(usage.toolsTokens)} />
        )}
        {usage.projectInstructionsTokens > 0 && (
          <Row
            label={`Project instructions (${instructionsFile ?? "LOACHFILE.md"})`}
            value={formatTokens(usage.projectInstructionsTokens)}
          />
        )}
        {usage.skillsTokens > 0 && (
          <Row label="Loaded skills" value={formatTokens(usage.skillsTokens)} />
        )}
        {usage.memoriesTokens > 0 && (
          <Row label="Memories" value={formatTokens(usage.memoriesTokens)} />
        )}
        {sourcesLabel && (
          <Row label={sourcesLabel} value={formatTokens(usage.sourcesTokens)} />
        )}
        <Row
          label={`Messages (${usage.messageCount})`}
          value={formatTokens(usage.messagesTokens)}
        />
        {usage.attachmentsTokens > 0 && (
          <Row
            label="of which attachments"
            value={formatTokens(usage.attachmentsTokens)}
            muted
          />
        )}
        <div className="my-1 h-px bg-foreground/10" />
        <Row label="Window" value={formatTokens(usage.total)} muted />
        <Row label="Remaining" value={formatTokens(Math.max(0, usage.total - usage.used))} muted />
      </dl>

      <p className="mt-2.5 text-[10.5px] leading-relaxed text-foreground/45">
        Estimate based on ~4 characters per token (~1 for Chinese, Japanese
        and Korean). Actual counts vary by model.
      </p>

      <button
        type="button"
        onClick={onCompact}
        disabled={compacting || !canCompact}
        className={cn(
          "mt-3 flex w-full items-center justify-center gap-2 rounded-full px-3 py-2 text-[12px] font-medium transition-colors",
          "bg-primary text-primary-foreground",
          "shadow-[0_4px_18px_-6px_rgb(var(--primary-glow)/0.55)]",
          "hover:bg-primary/90",
          "disabled:bg-primary/40 disabled:text-primary-foreground/70 disabled:cursor-not-allowed disabled:shadow-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        )}
      >
        {compacting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Compacting…
          </>
        ) : (
          <>
            <Sparkles className="h-3.5 w-3.5" />
            Compact context
          </>
        )}
      </button>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-foreground/45">
        {compacting
          ? "Summarizing earlier turns with the chat's model. This may take a moment."
          : canCompact
            ? "Summarizes older messages with the chat's model and replaces them with a brief recap in the system prompt."
            : "Not enough history yet — keep chatting and try again when usage climbs."}
      </p>

      {canExpand && (
        <>
          <div className="my-3 h-px bg-foreground/10" />

          <button
            type="button"
            onClick={onExpand}
            disabled={compacting}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-full px-3 py-2 text-[12px] font-medium transition-colors",
              "bg-foreground/[0.08] text-foreground/85",
              "hover:bg-foreground/[0.14] hover:text-foreground",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            )}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Expand context window
          </button>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-foreground/45">
            {expandedSize === usage.total * 2 ? "Doubles" : "Raises"} the window from{" "}
            {formatTokens(usage.total)} to {formatTokens(expandedSize)} tokens
            {expandedSize === usage.total * 2 ? "." : ", the most this model takes."}
          </p>
        </>
      )}
    </div>
  );
};

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between",
        muted ? "text-foreground/55" : "text-foreground/80",
      )}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
