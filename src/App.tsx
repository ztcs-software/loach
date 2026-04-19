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
import { SnippetDialog } from "@/components/SnippetDialog";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

const EMPTY_MESSAGES: Message[] = [];

export default function App() {
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateChats = useChatStore((s) => s.hydrate);
  const hydrateSpaces = useSpaceStore((s) => s.hydrate);
  const hydrateSnippets = useSnippetStore((s) => s.hydrate);
  const backgroundStyle = useSettingsStore((s) => s.background_style);
  const viewingSpaceId = useSpaceStore((s) => s.viewingSpaceId);
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined,
  );
  const messages = useChatStore((s) =>
    s.activeSessionId ? s.messages[s.activeSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
  const hasMessages = messages.length > 0;

  useEffect(() => {
    (async () => {
      await hydrateSettings();
      await hydrateSpaces();
      await hydrateSnippets();
      await hydrateChats();
    })();
  }, [hydrateSettings, hydrateSpaces, hydrateSnippets, hydrateChats]);

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

      <div className="relative flex h-full flex-col overflow-hidden text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          {viewingSpaceId ? (
            <SpaceView />
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
