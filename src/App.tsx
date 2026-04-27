import { useEffect } from "react";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/Sidebar";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatCanvas } from "@/components/ChatCanvas";
import { ChatInput } from "@/components/ChatInput";
import { ParameterPanel } from "@/components/ParameterPanel";
import { SettingsDialog } from "@/components/SettingsDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SpaceForm } from "@/components/SpaceForm";
import { SpaceView } from "@/components/SpaceView";
import { SpacesLibrary } from "@/components/SpacesLibrary";
import { SnippetDialog } from "@/components/SnippetDialog";
import { SnippetsLibrary } from "@/components/SnippetsLibrary";
import { ModelsView } from "@/components/ModelsView";
import { ModelsLibrary } from "@/components/ModelsLibrary";
import { LockScreen } from "@/components/LockScreen";
import { useChatStore } from "@/stores/chatStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useSecurityStore, lockUntilHydrated } from "@/stores/securityStore";
import { useUIStore } from "@/stores/uiStore";
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
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const viewingModel = useModelsStore((s) => s.viewingModel);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
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

  return (
    <TooltipProvider delayDuration={250}>
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
          <LockScreen />
        </div>
      ) : (
      <div className="relative flex h-full flex-col overflow-hidden text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          {viewingSpaceId ? (
            <SpaceView />
          ) : viewingModel ? (
            <ModelsView />
          ) : sidebarTab === "spaces" ? (
            <SpacesLibrary />
          ) : sidebarTab === "snippets" ? (
            <SnippetsLibrary />
          ) : sidebarTab === "models" ? (
            <ModelsLibrary />
          ) : (
            <>
              <main className="relative flex min-w-0 flex-1 flex-col">
                <ChatHeader session={session} />
                {hasMessages ? (
                  <>
                    <ChatCanvas />
                    <ChatInput />
                  </>
                ) : (
                  <HeroComposer />
                )}
              </main>
              <ParameterPanel session={session} />
            </>
          )}
        </div>
        <SettingsDialog />
        <SpaceForm />
        <SnippetDialog />
      </div>
      )}
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

function HeroComposer() {
  const insertDraft = useUIStore((s) => s.insertComposerDraft);
  const bgStyle = useSettingsStore((s) => s.background_style);
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
            How can I help today?
          </h1>
          <p className="mt-3 text-sm text-foreground/55">
            Ask anything — Loach runs your local models privately.
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
