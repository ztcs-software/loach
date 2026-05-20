import { useEffect, useState } from "react";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/Sidebar";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatCanvas } from "@/components/ChatCanvas";
import { ChatInput } from "@/components/ChatInput";
import { ParameterPanel } from "@/components/ParameterPanel";
import { SettingsDialog } from "@/components/SettingsDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SwitchVariantProvider } from "@/components/ui/switch";
import { SpaceForm } from "@/components/SpaceForm";
import { SpaceView } from "@/components/SpaceView";
import { SpacesLibrary } from "@/components/SpacesLibrary";
import { SnippetDialog } from "@/components/SnippetDialog";
import { SnippetsLibrary } from "@/components/SnippetsLibrary";
import { ModelsView } from "@/components/ModelsView";
import { ModelsLibrary } from "@/components/ModelsLibrary";
import { LockScreen } from "@/components/LockScreen";
import { Onboarding } from "@/components/Onboarding";
import { CodeCanvas } from "@/components/CodeCanvas";
import { SearchBar } from "@/components/SearchBar";
import { SelectionCopyButton } from "@/components/SelectionCopyButton";
import { ToastHost } from "@/components/ToastHost";
import { ConfirmDialogHost } from "@/components/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { SquarePen } from "lucide-react";
import { resolveDefaultModelChoice, useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { ollamaPreloadModel } from "@/lib/tauri";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useSecurityStore, lockUntilHydrated } from "@/stores/securityStore";
import { useUIStore } from "@/stores/uiStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

const EMPTY_MESSAGES: Message[] = [];

export default function App() {
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateChats = useChatStore((s) => s.hydrate);
  const hydrateSpaces = useSpaceStore((s) => s.hydrate);
  const hydrateSnippets = useSnippetStore((s) => s.hydrate);
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
  const messages = useChatStore((s) =>
    s.activeSessionId ? s.messages[s.activeSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
  const hasMessages = messages.length > 0;

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
  useEffect(() => {
    if (!unlocked) return;
    (async () => {
      await hydrateSettings();
      await hydrateSpaces();
      await hydrateSnippets();
      await hydrateChats();
      // Model list is cheap (one Ollama /api/tags call) but network-bound, so
      // fire it last — failure here shouldn't block the rest of the UI.
      await hydrateModels();

      // Optional default-model preload. Resolves the same encoded choice
      // that "New chat" would use, then warms the model into VRAM with an
      // empty Ollama chat so the first real request skips the cold load.
      // Cloud providers have no local load step, so we only fire for Ollama.
      // Fully fire-and-forget — Ollama may be unreachable or the model
      // missing; we never want this to surface as an error.
      const s = useSettingsStore.getState();
      if (s.default_model_preload) {
        const resolved = resolveDefaultModelChoice(
          s.default_model_choice,
          s.default_provider,
          s.default_model ?? "",
          useChatStore.getState().sessions,
        );
        if (resolved.provider === "ollama" && resolved.model) {
          void ollamaPreloadModel(s.ollama_base_url, resolved.model).catch(
            () => {},
          );
        }
      }
    })();
  }, [
    unlocked,
    hydrateSettings,
    hydrateSpaces,
    hydrateSnippets,
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
              <SpaceView />
            </ErrorBoundary>
          ) : viewingModel ? (
            <ErrorBoundary name="Model details">
              <ModelsView />
            </ErrorBoundary>
          ) : sidebarTab === "spaces" ? (
            <ErrorBoundary name="Spaces library">
              <SpacesLibrary />
            </ErrorBoundary>
          ) : sidebarTab === "snippets" ? (
            <ErrorBoundary name="Snippets library">
              <SnippetsLibrary />
            </ErrorBoundary>
          ) : sidebarTab === "models" ? (
            <ErrorBoundary name="Models library">
              <ModelsLibrary />
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
                    <NoChatState />
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
                {canvasOpen ? <CodeCanvas /> : <ParameterPanel session={session} />}
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
        <ErrorBoundary name="Space form">
          <SpaceForm />
        </ErrorBoundary>
        <ErrorBoundary name="Snippet editor">
          <SnippetDialog />
        </ErrorBoundary>
        {showOnboarding && (
          <ErrorBoundary name="Onboarding">
            <Onboarding />
          </ErrorBoundary>
        )}
      </div>
      )}
      {/* Global Cmd-K search palette. Lives at the App root so it floats
          above every surface (chat / library / lock screen-adjacent) and
          isn't tied to whichever main view is currently rendered. The
          component renders nothing until the user opens it via Ctrl/Cmd+K
          or the `loach:focus-search` event the sidebar fires. */}
      {/* Suppress search + selection-copy palettes while onboarding owns the
          screen — the wizard is modal and Cmd+K should stay inert until
          the user finishes or dismisses. */}
      {!showLock && !showOnboarding && <SearchBar />}
      {!showLock && !showOnboarding && <SelectionCopyButton />}
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
