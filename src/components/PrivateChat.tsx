import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Ghost,
  Info,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Sliders,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { FileChip } from "./FileChip";
import { Markdown } from "./Markdown";
import { fileToAttachment, FileTooLargeError } from "@/lib/files";
import { ollamaListModels, ollamaProbe } from "@/lib/tauri";
import {
  DEFAULT_PERSONA_ID,
  PERSONAS,
  type Persona,
} from "@/lib/personas";
import { DEFAULT_TONE_ID, TONES, type Tone } from "@/lib/tones";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import {
  usePrivateChatStore,
  type PrivateMessage,
} from "@/stores/privateChatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  DEFAULT_PARAMS,
  type Attachment,
  type GenerationParams,
  type ModelInfo,
} from "@/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// PrivateChat overlay
//
// A 90% viewport, dark-only surface for ephemeral conversations. Bypasses
// SQLite entirely (no createSession / appendMessage / updateMessage calls).
// Only Ollama is allowed. On close, all messages, attachments, and any
// persona / tone / instructions the user picked are wiped.
//
// Layout (when params sidebar is open):
//   ┌────────────────────────────────────────────┐
//   │ Header (title + model + params + close)    │
//   ├────────────────────────────────┬───────────┤
//   │ Body (transcript / empty hero) │ Params    │
//   │                                │ sidebar   │
//   │ Composer                       │           │
//   └────────────────────────────────┴───────────┘
// ---------------------------------------------------------------------------

export function PrivateChat() {
  const open = usePrivateChatStore((s) => s.open);
  const paramsOpen = usePrivateChatStore((s) => s.paramsOpen);

  if (!open) return null;

  return (
    // The overlay starts BELOW the app's title bar (`top-9` = 36 px, the
    // TitleBar's `h-9`) instead of covering the full viewport. The real
    // TitleBar stays visible and interactive at the top, so the user can
    // still drag the OS window, minimize, maximize, and close exactly the
    // same way as anywhere else in the app.
    //
    // Deliberately NO backdrop-click and NO Escape close handler: the
    // overlay's wipe() is destructive (transcript is gone the moment it
    // runs), so the only way out is the explicit X button in the header.
    <div
      className="dark fixed inset-x-0 bottom-0 top-9 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Private Chat"
    >
      <div className="dark flex h-[90vh] w-[90vw] max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-zinc-100 shadow-2xl">
        <PrivateChatHeader />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <PrivateChatBody />
            <PrivateChatComposer />
          </div>
          {paramsOpen && <PrivateParamsPanel />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — immutable title left, model picker + params toggle + close right
// ---------------------------------------------------------------------------

function PrivateChatHeader() {
  const wipe = usePrivateChatStore((s) => s.wipe);
  const paramsOpen = usePrivateChatStore((s) => s.paramsOpen);
  const setParamsOpen = usePrivateChatStore((s) => s.setParamsOpen);
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Ghost className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
        <span className="font-medium text-zinc-100">Private Chat</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ModelPicker />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setParamsOpen(!paramsOpen)}
          aria-label="Toggle parameters"
          aria-pressed={paramsOpen}
          title="Parameters"
          className={cn(
            "rounded-xl text-zinc-300 hover:bg-white/10 hover:text-zinc-50",
            paramsOpen && "bg-white/10 text-zinc-50",
          )}
        >
          <Sliders className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={wipe}
          aria-label="Close Private Chat"
          title="Close — wipes the conversation"
          className="rounded-xl text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model picker — Ollama only
// ---------------------------------------------------------------------------

function ModelPicker() {
  const model = usePrivateChatStore((s) => s.model);
  const setModel = usePrivateChatStore((s) => s.setModel);
  const ollamaBaseUrl = useSettingsStore((s) => s.ollama_base_url);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [up, setUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const probe = await ollamaProbe(ollamaBaseUrl).catch(() => false);
        setUp(probe);
        if (probe) {
          const m = await ollamaListModels(ollamaBaseUrl).catch(() => []);
          setModels(m);
          // Auto-pick a default model if none chosen yet — the user shouldn't
          // have to open the dropdown just to send their first message. Prefer
          // their most-recent Ollama model from regular sessions, falling
          // back to the first installed one.
          const current = usePrivateChatStore.getState().model;
          if (!current && m.length > 0) {
            const sessions = useChatStore.getState().sessions;
            const recent = sessions
              .filter((s) => s.provider === "ollama" && s.model)
              .sort((a, b) => b.updated_at - a.updated_at)[0]?.model;
            const preferred =
              recent && m.find((x) => x.id === recent) ? recent : m[0].id;
            setModel(preferred);
          }
        } else {
          setModels([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [ollamaBaseUrl, setModel],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Warm modelDefaults + modelCapabilities for the picked model so the
  // sidebar's source-info banner and the Thinking row can read them
  // without waiting on a round-trip the first time the user opens the
  // panel. Mirrors the regular chat's newSession / setSessionModel paths.
  const loadModelDefaults = useModelsStore((s) => s.loadModelDefaults);
  useEffect(() => {
    if (model) void loadModelDefaults(model);
  }, [model, loadModelDefaults]);

  // Same shape as the regular ChatHeader's picker label: "<model> · <provider>".
  // Private Chat is Ollama-only, so the provider is hard-coded — the suffix
  // exists for visual parity with the normal chat header more than for
  // information density.
  const label = model ? `${model} · ollama` : "Pick a model";

  return (
    // Refresh on every open as a safety net — if the user just `ollama pull`ed
    // a new model, the list will be current the next time they open the
    // picker without needing to click the explicit Refresh button.
    <DropdownMenu
      onOpenChange={(openNow) => {
        if (openNow) void refresh();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-8 max-w-[260px] rounded-full border border-white/15 bg-white/[0.03] text-zinc-200 hover:border-white/25 hover:bg-white/10 hover:text-zinc-50"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      {/* Two overrides to the shared `glass-panel`-based DropdownMenuContent:
          1. `z-[90]` lifts us above the overlay's `z-[80]` so the menu
             doesn't render behind the backdrop.
          2. The inline `style` kills the gradient + backdrop blur from
             `glass-panel` so the menu is a flat dark surface regardless of
             theme (Aurora vs Solid). Private Chat is always dark — and the
             user explicitly asked for no glass effect here.

          Layout mirrors the regular ChatHeader's picker: a header row with
          a "Models" label + Refresh icon button on the right, then a
          provider section. No API section — Private Chat is Ollama-only. */}
      <DropdownMenuContent
        align="end"
        // `dark` is essential here — DropdownMenuContent is portaled to
        // `<body>`, so it sits OUTSIDE the Private Chat overlay's `dark`
        // class scope. Every child (DropdownMenuLabel, DropdownMenuItem)
        // uses `text-foreground/X` classes that resolve `--foreground`
        // against the document root's active theme. In Solid Light mode
        // `--foreground` is dark — meaning the model names and "MODELS"
        // / "OLLAMA" labels rendered as dark-on-dark and were invisible.
        // Scoping `dark` here re-points those vars to the dark-theme
        // values (light text) regardless of the app's active theme.
        className="dark z-[90] min-w-[260px]"
        // The shared DropdownMenuContent carries a `glass-panel` class that
        // sets FOUR properties: background (gradient), backdrop-filter,
        // border, AND box-shadow (an inset top highlight + theme-aware
        // outer shadow). All four must be neutralised here or the residual
        // properties keep the "glass" feel — most visibly the 1 px white
        // inset line along the top edge of the menu in the previous screenshot.
        style={{
          // zinc-800 — one step lighter than the panel's zinc-900 surface
          // so the dropdown reads as an elevated popover.
          background: "rgb(39 39 42)",
          backgroundImage: "none",
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
          border: "1px solid rgb(255 255 255 / 0.10)",
          // Flat, neutral drop shadow for elevation. No inset highlight, no
          // theme-tinted glow. This is the property the previous override
          // missed; without `boxShadow: none` the glass-panel's `inset` and
          // `--glass-shadow` rules survived and the dropdown still looked
          // glassy along the top edge.
          boxShadow: "0 10px 30px -10px rgba(0, 0, 0, 0.6)",
        }}
      >
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Models</DropdownMenuLabel>
          <button
            type="button"
            className="rounded p-1 text-zinc-300 hover:bg-white/10 hover:text-zinc-50"
            onClick={(e) => {
              e.preventDefault();
              void refresh();
            }}
            aria-label="Refresh models"
            title="Refresh"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </button>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5">
          {up ? (
            <CircleCheck className="h-3 w-3 text-emerald-500" />
          ) : (
            <CircleAlert className="h-3 w-3 text-amber-500" />
          )}
          Ollama
        </DropdownMenuLabel>
        {models.length === 0 && (
          <DropdownMenuItem disabled>
            {up ? "No models installed" : "Ollama not running"}
          </DropdownMenuItem>
        )}
        {models.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => setModel(m.id)}>
            {m.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Body — empty state OR scrollable transcript
// ---------------------------------------------------------------------------

function PrivateChatBody() {
  const messages = usePrivateChatStore((s) => s.messages);
  const isStreaming = usePrivateChatStore((s) => s.isStreaming);
  const streamingId = usePrivateChatStore((s) => s.streamingMessageId);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distance < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
            <ShieldCheck className="h-6 w-6 text-zinc-300" />
          </div>
          <h2 className="text-2xl font-medium tracking-tight text-zinc-100">
            We are private
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">
            Private Chats are temporary conversations with nothing stored.
            <br />
            All messages are removed immediately when you close the chat.
            <br />
            Only local Ollama models can be used here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollerRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-4">
        {messages.map((m) => (
          <PrivateMessageBubble
            key={m.id}
            message={m}
            isStreaming={m.id === streamingId && isStreaming}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-message bubble. Slim renderer compared to the regular Message
// component: no kebab menus, no Save-as-Snippet, no Regenerate, no Bookmark.
// ---------------------------------------------------------------------------

function PrivateMessageBubble({
  message,
  isStreaming,
}: {
  message: PrivateMessage;
  isStreaming: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[78%] rounded-3xl rounded-tr-lg border border-white/[0.06] bg-white/[0.06] px-4 py-2.5 text-sm text-zinc-100">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.attachments.map((a, i) => (
                <span
                  key={`${a.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-zinc-300"
                >
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const showThinkingBlock =
    message.thinking && message.thinking.length > 0;
  const showStreamingDots = isStreaming && message.content.length === 0;
  return (
    <div className="mb-6 flex justify-start">
      <div className="min-w-0 max-w-full flex-1">
        {showThinkingBlock && (
          <ThinkingBlock text={message.thinking ?? ""} streaming={isStreaming} />
        )}
        {showStreamingDots ? (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-2 text-zinc-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:160ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:320ms]" />
          </div>
        ) : (
          <Markdown
            content={message.content}
            className="prose prose-invert prose-sm max-w-none text-zinc-100"
          />
        )}
        {message.metrics && !isStreaming && (
          <div className="mt-1 text-[11px] text-zinc-500">
            {message.metrics.tokens} tokens ·{" "}
            {Math.round(message.metrics.tokens_per_second)} tok/s
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Brain className="h-3.5 w-3.5" />
        <span>{streaming && !open ? "Thinking…" : "Thinking"}</span>
      </button>
      {open && (
        <div className="mt-1.5 ml-5 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-zinc-400">
          {text}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parameters sidebar — Simple-view contents
//
// Replicates the right-hand surface from the regular ParameterPanel's
// "Simple" tab: source info banner, Thinking toggle, Temperature slider,
// Context Length slider, Reset button, Persona pills, Tone pills, and
// per-chat Additional instructions. Every write goes to the in-memory
// privateChatStore — never to SQLite — so nothing about the user's
// prompt-shaping choices survives the overlay close.
// ---------------------------------------------------------------------------

const CTX_STOPS = [
  4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
];

function formatK(n: number) {
  if (n >= 1024 * 1024) {
    const m = n / 1024 / 1024;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function PrivateParamsPanel() {
  const setParamsOpen = usePrivateChatStore((s) => s.setParamsOpen);
  const model = usePrivateChatStore((s) => s.model);
  const params = usePrivateChatStore((s) => s.params);
  const setParams = usePrivateChatStore((s) => s.setParams);
  const personaId = usePrivateChatStore((s) => s.personaId);
  const setPersona = usePrivateChatStore((s) => s.setPersona);
  const toneId = usePrivateChatStore((s) => s.toneId);
  const setTone = usePrivateChatStore((s) => s.setTone);
  const additional = usePrivateChatStore((s) => s.additionalSystemPrompt);
  const setAdditional = usePrivateChatStore((s) => s.setAdditionalSystemPrompt);

  // Model defaults / capabilities power the source-info banner and the
  // Thinking-row enabled state. Read straight from modelsStore — they're
  // warmed when the model is picked (see ModelPicker's useEffect).
  const modelDefaults = useModelsStore((s) =>
    model ? s.modelDefaults[model] : undefined,
  );
  const modelCapabilities = useModelsStore((s) =>
    model ? s.modelCapabilities[model] : undefined,
  );
  const supportsThinking = modelCapabilities?.includes("thinking") ?? false;

  // Settings-level defaults that feed the merge — same as
  // chatStore.readSessionParams. Private Chat is Ollama-only so we don't
  // bother with the OpenAI branches.
  const thinkingDefault = useSettingsStore((s) => s.thinking_default);
  const defaultToneId = useSettingsStore((s) => s.default_tone_id);
  const effectiveToneId = toneId ?? defaultToneId ?? DEFAULT_TONE_ID;

  const hasOverrides = Object.keys(params).length > 0;
  const hasModelDefaults =
    !!modelDefaults && Object.keys(modelDefaults).length > 0;
  const sourceLabel = hasOverrides
    ? "Custom — adjusted for this session."
    : hasModelDefaults
      ? `Using ${model}'s Modelfile defaults.`
      : modelDefaults === undefined && model
        ? "Loading model defaults…"
        : "Using app defaults — this model lists no overrides.";

  // Effective values shown on each row mirror chatStore.readSessionParams'
  // merge order: DEFAULT_PARAMS < thinking-default < modelDefaults <
  // user overrides. We don't need the per-model think pref or space
  // defaults — Private Chat doesn't touch those layers.
  const effectiveTemperature =
    params.temperature ??
    modelDefaults?.temperature ??
    DEFAULT_PARAMS.temperature ??
    0.7;
  const effectiveContext =
    params.num_ctx ?? modelDefaults?.num_ctx ?? DEFAULT_PARAMS.num_ctx ?? 8192;
  const effectiveThinking =
    params.think ?? modelDefaults?.think ?? thinkingDefault;

  const update = (patch: Partial<GenerationParams>) =>
    setParams({ ...params, ...patch });

  const resetParams = () => setParams({});

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-hidden border-l border-white/[0.07] bg-zinc-900">
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-tight">Parameters</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setParamsOpen(false)}
          aria-label="Close parameters panel"
          className="h-7 w-7 rounded-full text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="scrollbar-hidden relative flex-1 overflow-y-auto px-4 pb-6 pt-1">
        <div className="space-y-6">
          <div className="flex items-start gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11px] text-zinc-300">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500" />
            <span className="leading-snug">{sourceLabel}</span>
          </div>

          <Section title="Thinking">
            <ThinkingRow
              checked={effectiveThinking ?? supportsThinking}
              disabled={!supportsThinking}
              disabledHint={
                modelCapabilities === undefined && model
                  ? "Loading model capabilities…"
                  : "This model doesn't support a thinking step."
              }
              onChange={(next) => update({ think: next })}
            />
          </Section>

          <Section title="Sampling">
            <SliderRow
              label="Temperature"
              value={Math.min(effectiveTemperature, 1)}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => update({ temperature: v })}
              hint="Controls randomness. Lower stays focused and predictable; higher gets more creative and varied."
            />
          </Section>

          <Section title="Length">
            <SliderRow
              label="Context Length"
              value={effectiveContext}
              stops={CTX_STOPS}
              format={formatK}
              onChange={(v) => update({ num_ctx: Math.round(v) })}
              hint="How much conversation history the model can see at once. Larger windows remember more but use more VRAM."
            />
          </Section>

          <div className="pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetParams}
              disabled={!hasOverrides}
              className="h-8 w-full gap-1.5 rounded-lg border-white/15 bg-white/[0.04] px-3 text-[11px] font-semibold text-zinc-200 hover:border-white/25 hover:bg-white/10 hover:text-zinc-50 disabled:opacity-40"
              title={
                hasModelDefaults
                  ? "Drop overrides and follow this model's Modelfile defaults."
                  : "Drop overrides and follow the app defaults."
              }
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {hasModelDefaults ? "Reset to model defaults" : "Reset to defaults"}
            </Button>
          </div>

          <div className="h-px bg-white/[0.08]" />

          <div>
            <Label className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-300">
              Persona
            </Label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PERSONAS.map((p) => (
                <PersonaPill
                  key={p.id}
                  persona={p}
                  active={
                    personaId
                      ? personaId === p.id
                      : p.id === DEFAULT_PERSONA_ID
                  }
                  onClick={() =>
                    setPersona(p.id === DEFAULT_PERSONA_ID ? null : p.id)
                  }
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
              Defines the assistant's role. Layered into the system prompt at send time.
            </p>
          </div>

          <div>
            <Label className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-300">
              Tone
            </Label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TONES.map((t) => (
                <TonePill
                  key={t.id}
                  tone={t}
                  active={effectiveToneId === t.id}
                  onClick={() =>
                    setTone(t.id === DEFAULT_TONE_ID ? null : t.id)
                  }
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
              Style modifier appended after the system prompt. Falls back to your global default in Settings → General when not set here.
            </p>
          </div>

          <div>
            <Label
              htmlFor="private-system-prompt"
              className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-300"
            >
              Additional instructions (this chat)
            </Label>
            <Textarea
              id="private-system-prompt"
              rows={5}
              placeholder="Extra instructions for this chat — sit between the persona and the tone…"
              className="mt-2 resize-none border-white/10 bg-white/[0.04] text-sm focus-visible:border-white/25 focus-visible:ring-0"
              value={additional}
              onChange={(e) => setAdditional(e.target.value)}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
              Free-form per-chat instructions. Wiped along with everything else when the chat closes.
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sidebar helpers — small primitives duplicated from ParameterPanel.tsx
// rather than imported. The originals are tightly coupled to chatStore /
// session shape; replicating the markup keeps the private surface
// independent and means a change in the regular panel can't accidentally
// leak persistence behaviour into here.
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-300">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function ThinkingRow({
  checked,
  disabled,
  disabledHint,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  disabledHint: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={disabled ? "opacity-55" : undefined}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 shrink-0 text-zinc-300" />
          <Label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-300">
            Thinking
          </Label>
        </div>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={checked ? "Disable thinking" : "Enable thinking"}
        />
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-zinc-500">
        {disabled
          ? disabledHint
          : "Let the model reason step-by-step before replying. Adds latency for long answers but may improve quality on complex prompts."}
      </p>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min = 0,
  max = 0,
  step = 1,
  precision = 2,
  onChange,
  hint,
  stops,
  format,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  onChange: (v: number) => void;
  hint?: string;
  stops?: number[];
  format?: (v: number) => string;
}) {
  const usingStops = stops && stops.length > 0;
  const stopIdx = usingStops
    ? (() => {
        let best = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < stops!.length; i++) {
          const d = Math.abs(stops![i] - value);
          if (d < bestDiff) {
            bestDiff = d;
            best = i;
          }
        }
        return best;
      })()
    : 0;
  const displayValue = usingStops ? stops![stopIdx] : value;
  const displayText = format
    ? format(displayValue)
    : displayValue.toFixed(precision);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <Label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-300">
          {label}
        </Label>
        <span className="font-mono text-xs tabular-nums text-zinc-100">
          {displayText}
        </span>
      </div>
      {usingStops ? (
        <Slider
          value={[stopIdx]}
          min={0}
          max={stops!.length - 1}
          step={1}
          onValueChange={(v) => onChange(stops![v[0]])}
        />
      ) : (
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => onChange(v[0])}
        />
      )}
      {hint && (
        <p className="mt-1.5 text-[10.5px] leading-snug text-zinc-500">
          {hint}
        </p>
      )}
    </div>
  );
}

function PersonaPill({
  persona,
  active,
  onClick,
}: {
  persona: Persona;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = persona.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={persona.description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
        active
          ? "border-zinc-300 bg-transparent font-bold text-zinc-50"
          : "border-white/10 bg-white/[0.04] font-medium text-zinc-300 hover:border-white/25 hover:bg-white/10 hover:text-zinc-50",
      )}
    >
      <Icon className="h-3 w-3" />
      {persona.label}
    </button>
  );
}

function TonePill({
  tone,
  active,
  onClick,
}: {
  tone: Tone;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = tone.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={tone.description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
        active
          ? "border-zinc-300 bg-transparent font-bold text-zinc-50"
          : "border-white/10 bg-white/[0.04] font-medium text-zinc-300 hover:border-white/25 hover:bg-white/10 hover:text-zinc-50",
      )}
    >
      <Icon className="h-3 w-3" />
      {tone.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function PrivateChatComposer() {
  const send = usePrivateChatStore((s) => s.send);
  const cancel = usePrivateChatStore((s) => s.cancel);
  const isStreaming = usePrivateChatStore((s) => s.isStreaming);
  const model = usePrivateChatStore((s) => s.model);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const ingest = async (files: File[]) => {
    setError(null);
    const next: Attachment[] = [];
    for (const f of files) {
      try {
        next.push(await fileToAttachment(f));
      } catch (e) {
        if (e instanceof FileTooLargeError) {
          setError(`${e.name} is larger than 20 MB.`);
        } else {
          setError("Failed to read file");
        }
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next]);
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await ingest(Array.from(e.target.files));
    e.target.value = "";
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (isStreaming) return;
    setError(null);
    setText("");
    const toSend = attachments;
    setAttachments([]);
    try {
      await send(trimmed, toSend);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    }
  };

  const onPrimary = () => {
    if (isStreaming) {
      void cancel();
      return;
    }
    void submit();
  };

  const disabled =
    (!isStreaming && !text.trim() && attachments.length === 0) || !model;

  const placeholder = !model
    ? "Pick an Ollama model to start the conversation…"
    : isStreaming
      ? "Replying — press Stop to cancel…"
      : "Type a private message…";

  return (
    // Outer padding matches the regular ChatInput's non-centered mode
    // (`px-4 pb-5 pt-3`) so the composer sits at the same offset from the
    // panel edge as it does in a normal chat.
    <div className="relative px-4 pb-5 pt-3">
      <div className="mx-auto w-full max-w-3xl">
        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {attachments.map((a, i) => (
              <FileChip
                key={`${a.name}-${i}`}
                attachment={a}
                onRemove={() =>
                  setAttachments((arr) => arr.filter((_, j) => j !== i))
                }
              />
            ))}
          </div>
        )}
        {/* Flat pill: same shape and padding as the regular composer
            (`rounded-[28px] px-4 py-3`) but with a single solid fill
            instead of `glass-prompt`'s gradient + inset highlight +
            theme-accent glow. No gradients, no inset 3D edge, no
            colored glow — just a flat surface with a hairline border.
            Focus only nudges the border, never the fill. */}
        <div className="relative flex items-end gap-2 rounded-[28px] border border-white/[0.14] bg-white/[0.04] px-4 py-3 transition-colors focus-within:border-white/[0.24]">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
            className="rounded-full text-zinc-300/80 hover:bg-white/10 hover:text-zinc-100"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
            className="hidden"
            onChange={onPick}
          />
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            // The Textarea primitive ships with `bg-foreground/[0.05]`,
            // `focus-visible:bg-foreground/[0.07]`, and `backdrop-blur-xl`
            // as defaults. tailwind-merge collapses `bg-foreground/[0.05]`
            // to our `bg-transparent`, but the FOCUS-variant background
            // and the backdrop-blur are independent classes that survive
            // unless explicitly nulled. Without these overrides, focusing
            // the field flashed a translucent inner panel inside our
            // flat pill. Mirrors the regular ChatInput's overrides.
            className="min-h-[28px] max-h-[220px] flex-1 resize-none border-none bg-transparent backdrop-blur-none px-1 py-1.5 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 shadow-none outline-none focus-visible:ring-0 focus-visible:border-none focus-visible:bg-transparent focus-visible:outline-none"
            rows={1}
          />
          <button
            type="button"
            onClick={onPrimary}
            disabled={disabled}
            aria-label={isStreaming ? "Stop generating" : "Send message"}
            title={isStreaming ? "Stop generating" : "Send"}
            className={cn(
              // h-10 w-10 matches the regular PrimaryButton's footprint.
              "relative h-10 w-10 shrink-0 rounded-full transition-colors",
              // Dimmed equivalent of the regular bg-primary fill: a soft
              // off-white for the active state, a muted zinc for hover,
              // and a dark zinc for disabled. No colored glow shadow —
              // a plain dark drop shadow keeps the visual quiet.
              "bg-zinc-200 text-zinc-900 shadow-[0_6px_24px_-4px_rgb(0_0_0/0.55)]",
              "hover:bg-white",
              "disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400 disabled:shadow-[0_4px_18px_-6px_rgb(0_0_0/0.4)]",
            )}
          >
            <span className="relative grid h-5 w-5 place-items-center mx-auto">
              <ArrowUp
                aria-hidden
                strokeWidth={2.5}
                className={cn(
                  "absolute h-5 w-5 transition-all duration-200 ease-out",
                  isStreaming
                    ? "scale-50 rotate-90 opacity-0"
                    : "scale-100 rotate-0 opacity-100",
                )}
              />
              <Square
                aria-hidden
                className={cn(
                  "absolute h-3 w-3 fill-current transition-all duration-200 ease-out",
                  isStreaming
                    ? "scale-100 rotate-0 opacity-100"
                    : "scale-50 -rotate-90 opacity-0",
                )}
              />
            </span>
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      </div>
    </div>
  );
}
