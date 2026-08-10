import { lazy, Suspense, useEffect, useState } from "react";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/Sidebar";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatCanvas } from "@/components/ChatCanvas";
import { ChatInput } from "@/components/ChatInput";
import { ParameterPanel } from "@/components/ParameterPanel";
import { SettingsDialog } from "@/components/SettingsDialog";
import { HelpDialog } from "@/components/HelpDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SwitchVariantProvider } from "@/components/ui/switch";
import { SpaceForm } from "@/components/SpaceForm";
// Lazily loaded surfaces — each renders only when the user navigates to it
// (a space/model view, a sidebar library, the code canvas, onboarding), so
// splitting them out keeps their code (and deps) out of the initial bundle
// that the chat path pays to parse on every cold start. They each already sit
// behind a render condition below, so the chunk loads exactly when first shown.
const SpaceView = lazy(() =>
  import("@/components/SpaceView").then((m) => ({ default: m.SpaceView })),
);
const SpacesLibrary = lazy(() =>
  import("@/components/SpacesLibrary").then((m) => ({ default: m.SpacesLibrary })),
);
import { SnippetDialog } from "@/components/SnippetDialog";
import { SnippetVariableDialog } from "@/components/SnippetVariableDialog";
import { SnippetVariableFillDialog } from "@/components/SnippetVariableFillDialog";
const SnippetsLibrary = lazy(() =>
  import("@/components/SnippetsLibrary").then((m) => ({ default: m.SnippetsLibrary })),
);
const ModelsView = lazy(() =>
  import("@/components/ModelsView").then((m) => ({ default: m.ModelsView })),
);
const ModelsLibrary = lazy(() =>
  import("@/components/ModelsLibrary").then((m) => ({ default: m.ModelsLibrary })),
);
import { LockScreen } from "@/components/LockScreen";
const Onboarding = lazy(() =>
  import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })),
);
const CodeCanvas = lazy(() =>
  import("@/components/CodeCanvas").then((m) => ({ default: m.CodeCanvas })),
);
import { SearchBar } from "@/components/SearchBar";
import { UpdateAvailableDialog } from "@/components/UpdateAvailableDialog";
import { PrivateChat } from "@/components/PrivateChat";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { ToastHost } from "@/components/ToastHost";
import { ConfirmDialogHost } from "@/components/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { SquarePen } from "lucide-react";
import { resolveDefaultModelChoice, useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { ollamaPreloadModel, ollamaStart } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSnippetVarStore } from "@/stores/snippetVarStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useSecurityStore, lockUntilHydrated } from "@/stores/securityStore";
import { useUIStore } from "@/stores/uiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { cn } from "@/lib/utils";
import { DEFAULT_PARAMS } from "@/types";

export default function App() {
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateChats = useChatStore((s) => s.hydrate);
  const hydrateSpaces = useSpaceStore((s) => s.hydrate);
  const hydrateSnippets = useSnippetStore((s) => s.hydrate);
  const hydrateSnippetVars = useSnippetVarStore((s) => s.hydrate);
  const hydrateModels = useModelsStore((s) => s.hydrate);
  const hydrateSecurity = useSecurityStore((s) => s.hydrate);
  const securityHydrated = useSecurityStore((s) => s.hydrated);
  const securityConfigured = useSecurityStore((s) => s.status.configured);
  const unlocked = useSecurityStore((s) => s.unlocked);
  const backgroundStyle = useSettingsStore((s) => s.background_style);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const onboardingCompleted = useSettingsStore(
    (s) => s.onboarding_completed,
  );
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const viewingModel = useModelsStore((s) => s.viewingModel);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const canvasOpen = useCanvasStore((s) => s.isOpen);
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined,
  );
  // Subscribe to a boolean, NOT the messages array: the array's identity
  // changes on every streaming flush, so selecting the array here re-rendered
  // the whole App shell ~60×/s mid-stream even though only `.length > 0` is
  // ever read. Returning the primitive lets zustand's Object.is bail.
  const hasMessages = useChatStore((s) =>
    s.activeSessionId
      ? (s.messages[s.activeSessionId]?.length ?? 0) > 0
      : false,
  );
  // True only during the post-unlock hydrate window. Lets us swap the
  // "No chat open" CTA for a loading skeleton so users with chats on disk
  // don't briefly see an empty-state message that tells them to create one.
  const chatsHydrated = useChatStore((s) => s.hydrated);

  // Phase 1 — security probe. Pessimistically lock (so the chat UI never
  // flashes) and ask the backend whether a lock is configured. The store's
  // hydrate() flips `unlocked` back to true when no lock exists.
  useEffect(() => {
    lockUntilHydrated();
    void hydrateSecurity();
  }, [hydrateSecurity]);

  // Phase 2 — once we're past the lock screen, hydrate the rest of the app.
  // Doing this after unlock keeps the lock surface snappy and avoids
  // shipping any chat data into memory while the user is still proving
  // they're allowed to see it.
  //
  // The five hydrates are independent — none of their `hydrate()` methods
  // reads from another store — so we fan them out in parallel. The prior
  // sequential await chain was the dominant chunk of post-unlock latency,
  // since IPC round-trips stack additively. Parallelising collapses them
  // to the slowest single call (typically `hydrateModels`, which is
  // network-bound to Ollama).
  //
  // The Ollama preload only needs `settings` + `sessions` to resolve the
  // default model choice, so we kick it off as soon as those two land
  // rather than waiting for spaces/snippets/models. That shaves the
  // model's cold-load into VRAM (often the single biggest chunk of
  // time-to-first-token) off the path the user actually waits on.
  useEffect(() => {
    // Wait for BOTH the security probe to land AND the user to be unlocked.
    // Gating only on `unlocked` was a leak: this effect's closure captured the
    // store's optimistic initial `unlocked: true` from the first render
    // (phase 1's `lockUntilHydrated()` can't retroactively change an
    // already-captured closure value), so every store hydrated beneath the
    // lock screen. `hydrated` is false on first render and only flips true in
    // the same atomic update that sets the correct `unlocked`, so gating on it
    // closes that window.
    if (!securityHydrated || !unlocked) return;

    const settingsP = hydrateSettings();
    const chatsP = hydrateChats();
    void hydrateSpaces();
    void hydrateSnippets();
    void hydrateSnippetVars();
    // `hydrateModels` is network-bound (Ollama /api/tags) — fire-and-forget
    // so its latency never blocks anything the user sees.
    void hydrateModels();

    // Optional Ollama auto-launch. Starts `ollama serve` if nothing is
    // answering, so a user who lives in Loach doesn't have to keep the
    // daemon running themselves. Resolves in the same tick when the setting
    // is off, so nobody who hasn't opted in pays for the extra probe.
    //
    // Failures stay in the log rather than a startup toast: the model picker
    // already shows "Not running" with a Start Ollama button that surfaces
    // the same error on demand, which is a better place to see it than a
    // banner over a cold app.
    const ollamaReady = settingsP.then(async () => {
      const s = useSettingsStore.getState();
      if (!s.ollama_auto_launch) return;
      try {
        await ollamaStart(s.ollama_base_url);
      } catch (e) {
        logger.warn("ollama auto-launch failed", e);
        return;
      }
      // `hydrateModels` above raced the launch and listed an empty catalog.
      // Redo it now that there's a server to ask.
      void useModelsStore.getState().refresh();
    });

    // Optional default-model preload. Resolves the same encoded choice
    // that "New chat" would use, then warms the model into VRAM with an
    // empty Ollama chat so the first real request skips the cold load.
    // Cloud providers have no local load step, so we only fire for Ollama.
    // Fully fire-and-forget — Ollama may be unreachable or the model
    // missing; we never want this to surface as an error. Waits on
    // `ollamaReady` so an auto-launched server is up before we try to warm
    // a model in it; that promise is a no-op when auto-launch is off.
    void Promise.all([settingsP, chatsP, ollamaReady]).then(() => {
      const s = useSettingsStore.getState();
      if (!s.default_model_preload) return;
      const resolved = resolveDefaultModelChoice(
        s.default_model_choice,
        s.default_provider,
        s.default_model ?? "",
        useChatStore.getState().sessions,
      );
      if (resolved.provider === "ollama" && resolved.model) {
        // Resolve the runner-affecting params a fresh chat with this model
        // would send (num_ctx from the Modelfile defaults, else the app
        // default; plus the global low-VRAM pin) so the warmed model isn't
        // reloaded the instant the user sends their first message.
        void useModelsStore
          .getState()
          .loadModelDefaults(resolved.model)
          .then((md) => {
            void ollamaPreloadModel(
              s.ollama_base_url,
              resolved.model,
              md.num_ctx ?? DEFAULT_PARAMS.num_ctx,
              s.low_vram_global ? true : md.low_vram,
              md.num_gpu,
            ).catch(() => {});
          })
          .catch(() => {});
      }
    });
  }, [
    securityHydrated,
    unlocked,
    hydrateSettings,
    hydrateSpaces,
    hydrateSnippets,
    hydrateSnippetVars,
    hydrateChats,
    hydrateModels,
  ]);

  // While waiting for the security probe to land, render only the
  // background — no titlebar, no sidebar, no chat. Otherwise users would
  // see a brief flash of the unlocked UI before the lock screen mounts.
  const showLock = securityHydrated && securityConfigured && !unlocked;
  const probing = !securityHydrated;
  // Onboarding gate. Mounts only once the rest of the app has hydrated
  // (so we don't pop the wizard before settings load and then yank it
  // away when `onboarding_completed=true` arrives). Sits above the
  // chat surface but below the TitleBar so window controls keep
  // working — same pattern as LockScreen.
  const showOnboarding =
    !showLock && !probing && settingsHydrated && !onboardingCompleted;

  return (
    <TooltipProvider delayDuration={250}>
      {/* SwitchVariantProvider tells the Switch primitive which visual
          style to use by default ("glassy" on the Aurora gradient,
          "flat" on the Solid background). Keeps the primitive
          store-agnostic — only this single read of `background_style`
          here is coupled to the settings store. */}
      <SwitchVariantProvider
        value={backgroundStyle === "gradient" ? "glassy" : "flat"}
      >
      {/* ConfirmDialogHost wraps everything below so any descendant can
          call `useConfirm()` to surface a styled confirm/prompt dialog.
          Replaces the native `window.confirm()` / `window.prompt()`
          modals, which look like browser chrome inside our Tauri shell. */}
      <ConfirmDialogHost>
      {/* Background layer — gradient mesh or solid, per settings */}
      <div
        className={cn(
          "fixed inset-0 -z-10 overflow-hidden",
          backgroundStyle === "gradient" ? "app-mesh" : "app-solid",
        )}
        aria-hidden
      />

      {/* Lock gate. While the security probe is in flight we render nothing
          past the background so the app boot doesn't briefly leak chat UI
          before the lock screen mounts. Once a lock is confirmed and the
          user is still locked, the LockScreen takes over. The TitleBar
          mounts above the LockScreen so the window controls (min/max/
          close-to-tray) keep working at the lock screen too. */}
      {probing ? null : showLock ? (
        <div className="relative flex h-full flex-col overflow-hidden text-foreground">
          <TitleBar />
          {/* `scope="app"` on the lock screen specifically — if the unlock UI
              crashes, "Try again" would leave the user stuck staring at a
              broken lock with no way through. Reload is the only safe out. */}
          <ErrorBoundary name="Lock screen" scope="app">
            <LockScreen />
          </ErrorBoundary>
        </div>
      ) : (
      <div className="relative flex h-full flex-col overflow-hidden text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          {viewingSpaceId ? (
            <ErrorBoundary name="Space">
              <Suspense fallback={null}>
                <SpaceView />
              </Suspense>
            </ErrorBoundary>
          ) : viewingModel ? (
            <ErrorBoundary name="Model details">
              <Suspense fallback={null}>
                <ModelsView />
              </Suspense>
            </ErrorBoundary>
          ) : sidebarTab === "spaces" ? (
            <ErrorBoundary name="Spaces library">
              <Suspense fallback={null}>
                <SpacesLibrary />
              </Suspense>
            </ErrorBoundary>
          ) : sidebarTab === "snippets" ? (
            <ErrorBoundary name="Snippets library">
              <Suspense fallback={null}>
                <SnippetsLibrary />
              </Suspense>
            </ErrorBoundary>
          ) : sidebarTab === "models" ? (
            <ErrorBoundary name="Models library">
              <Suspense fallback={null}>
                <ModelsLibrary />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <>
              {/* Chat surface and right slot get their own boundaries so a
                  crash in markdown rendering or a parameter widget doesn't
                  take the whole pair down — the user still has the other
                  half to work with. */}
              <ErrorBoundary name="Chat">
                <main className="relative flex min-w-0 flex-1 flex-col">
                  <ChatHeader session={session} />
                  {!session ? (
                    // During the brief hydrate window we don't yet know
                    // whether the user has zero chats or just chats that
                    // haven't loaded yet. The skeleton avoids telling them
                    // they have no chats when they actually do.
                    chatsHydrated ? <NoChatState /> : <ChatLoadingSkeleton />
                  ) : hasMessages ? (
                    <>
                      <ChatCanvas />
                      <ChatInput />
                    </>
                  ) : (
                    <HeroComposer />
                  )}
                </main>
              </ErrorBoundary>
              {/* Right slot: code canvas wins over parameters when both are
                  open. Stacking them would need a tab UI we haven't designed
                  yet; mutually exclusive matches ChatGPT's behaviour and
                  keeps the layout legible. The canvas store survives across
                  this swap, so the user's snippet is still there if they
                  toggle params back. */}
              <ErrorBoundary name={canvasOpen ? "Code canvas" : "Parameters"}>
                {canvasOpen ? (
                  <Suspense fallback={null}>
                    <CodeCanvas />
                  </Suspense>
                ) : (
                  <ParameterPanel session={session} />
                )}
              </ErrorBoundary>
            </>
          )}
        </div>
        {/* Dialogs each get their own boundary. They're mounted unconditionally
            (Radix decides visibility internally) so a render crash in any one
            would otherwise blank the whole app. */}
        <ErrorBoundary name="Settings">
          <SettingsDialog />
        </ErrorBoundary>
        <ErrorBoundary name="Help">
          <HelpDialog />
        </ErrorBoundary>
        <ErrorBoundary name="Space form">
          <SpaceForm />
        </ErrorBoundary>
        <ErrorBoundary name="Snippet editor">
          <SnippetDialog />
        </ErrorBoundary>
        <ErrorBoundary name="Snippet variable editor">
          <SnippetVariableDialog />
        </ErrorBoundary>
        <ErrorBoundary name="Snippet variable fill">
          <SnippetVariableFillDialog />
        </ErrorBoundary>
        {showOnboarding && (
          <ErrorBoundary name="Onboarding">
            <Suspense fallback={null}>
              <Onboarding />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
      )}
      {/* Global Cmd-K search palette. Lives at the App root so it floats
          above every surface (chat / library / lock screen-adjacent) and
          isn't tied to whichever main view is currently rendered. The
          component renders nothing until the user opens it via Ctrl/Cmd+K
          or the `loach:focus-search` event the sidebar fires. */}
      {/* Suppress the search palette while onboarding owns the screen — the
          wizard is modal and Cmd+K should stay inert until the user finishes
          or dismisses. */}
      {!showLock && !showOnboarding && <SearchBar />}
      {/* Global keyboard shortcuts. Mounts below the same lock/onboarding
          gates as SearchBar — the handler itself ALSO checks those gates
          plus private chat at the moment of keypress, so re-mounting on
          gate transitions doesn't matter; this conditional just keeps the
          ShortcutListDialog out of the tree while the gates are active. */}
      {!showLock && !showOnboarding && <KeyboardShortcuts />}
      {/* Private Chat overlay. Suppressed during lock/onboarding for the
          same reason as the search palette — those gates own the screen.
          The component renders nothing until the user opens it from the
          title bar; opening it is also what cancels any running regular
          chat (see TitleBar.openPrivateChat). */}
      {!showLock && !showOnboarding && <PrivateChat />}
      {/* Launch-time "Update available" notice. Behind the same gates as the
          surfaces above — a modal about updates shouldn't land on top of the
          lock screen or interrupt first-run onboarding. Renders nothing
          unless the `auto_check_updates` setting is on AND the check finds a
          newer release. */}
      {!showLock && !showOnboarding && (
        <ErrorBoundary name="Update notice">
          <UpdateAvailableDialog />
        </ErrorBoundary>
      )}
      {/* Global toast host. Mounted unconditionally so messages from any
          surface (including the lock screen path, in the future) land in a
          predictable spot. Renders nothing when no toasts are queued. */}
      <ToastHost />
      </ConfirmDialogHost>
      </SwitchVariantProvider>
    </TooltipProvider>
  );
}

const SUGGESTIONS: { label: string; prompt: string }[] = [
  {
    label: "Explain a concept",
    prompt: "Explain the following concept clearly, with a small example: ",
  },
  {
    label: "Write code",
    prompt: "Write a function in TypeScript that ",
  },
  {
    label: "Summarize a file",
    prompt:
      "Summarize the attached file in 5 bullet points, highlighting the key takeaways.",
  },
  {
    label: "Brainstorm",
    prompt: "Help me brainstorm 10 creative ideas about ",
  },
];

const HERO_GREETINGS = [
  "How can I help today?",
  "Where shall we begin?",
  "What's on your mind today?",
  "What can I do for you?",
  "What are we working on?",
];

/**
 * Shown when the user has no active chat — typically because they just
 * deleted or archived their last one. Unlike HeroComposer (which still has
 * a working composer because a fresh empty session is already open), there
 * is no session to send into here, so we surface a single "New chat" CTA
 * that calls into the same `newSession` the sidebar uses.
 */
/**
 * Centered, low-contrast "still loading" placeholder for the chat surface.
 * Shown for the ~100–300 ms window between unlock and `chatStore.hydrate()`
 * completing. We intentionally don't use a spinner — most loads are too fast
 * for one to register as anything other than a flash, and the soft pulsing
 * card matches the rest of the app's quiet visual language.
 */
function ChatLoadingSkeleton() {
  return (
    <div
      className="flex flex-1 items-center justify-center px-6"
      aria-busy
      aria-label="Loading chats"
    >
      <div className="w-full max-w-md animate-pulse text-center">
        <div className="mx-auto h-4 w-32 rounded-full bg-foreground/[0.06]" />
        <div className="mx-auto mt-3 h-3 w-48 rounded-full bg-foreground/[0.04]" />
      </div>
    </div>
  );
}

function NoChatState() {
  const newSession = useChatStore((s) => s.newSession);
  const start = () => void newSession({ spaceId: null });
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="-mt-10 max-w-md text-center">
        <h2 className="text-xl font-medium text-foreground/85">
          No chat open
        </h2>
        <p className="mt-2 text-sm text-foreground/55">
          Create a new chat to start a conversation.
        </p>
        <Button onClick={start} className="mt-5 gap-2 rounded-full px-5">
          <SquarePen className="h-4 w-4" />
          New chat
        </Button>
      </div>
    </div>
  );
}

function HeroComposer() {
  const insertDraft = useUIStore((s) => s.insertComposerDraft);
  const bgStyle = useSettingsStore((s) => s.background_style);

  // Pick a greeting once per mount so it stays stable while this hero is
  // visible but re-rolls on every fresh empty-state visit (new chat etc.).
  const [headingText] = useState(
    () => HERO_GREETINGS[Math.floor(Math.random() * HERO_GREETINGS.length)],
  );

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-3xl -mt-10">
        <div className="mb-8 text-center">
          <h1
            className={cn(
              "pb-1 text-4xl font-medium tracking-tight sm:text-5xl",
              bgStyle === "gradient"
                ? "bg-gradient-to-br from-foreground via-foreground/90 to-orange-500 bg-clip-text text-transparent"
                : "text-foreground",
            )}
          >
            {headingText}
          </h1>
          <p className="mt-3 text-sm text-foreground/55">
            Ask anything. Loach runs your local models privately and securely.
          </p>
        </div>
        <ChatInput centered />
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => insertDraft(s.prompt)}
              className="chip-glass rounded-full px-4 py-2 text-xs font-medium transition-colors"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
