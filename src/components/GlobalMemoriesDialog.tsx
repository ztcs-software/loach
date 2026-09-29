import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemoryList } from "@/components/MemoryList";
import { useChatStore } from "@/stores/chatStore";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";

const EMPTY: never[] = [];

/** Editor for the global memory list, opened from Settings → Features. */
export function GlobalMemoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const memories = useGlobalMemoryStore((s) => s.memories);
  const load = useGlobalMemoryStore((s) => s.load);
  const addMemory = useGlobalMemoryStore((s) => s.addMemory);
  const updateMemory = useGlobalMemoryStore((s) => s.updateMemory);
  const removeMemory = useGlobalMemoryStore((s) => s.removeMemory);
  const enabled = useSettingsStore((s) => s.global_memory_enabled);

  useEffect(() => {
    if (open && memories === null) {
      void load().catch((e) => notify("load global memories", e));
    }
  }, [open, memories, load]);

  const openChat = (sessionId: string) => {
    // Leave both dialogs and any Space view behind so the chat is actually
    // visible when the selection lands.
    onOpenChange(false);
    useUIStore.getState().setSettingsOpen(false);
    useSpaceStore.getState().setViewingSpace(null);
    useUIStore.getState().setSidebarTab("chats");
    void useChatStore.getState().selectSession(sessionId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl !rounded-3xl">
        <DialogHeader>
          <DialogTitle>Global memories</DialogTitle>
          <DialogDescription>
            Facts the assistant remembers in every chat, inside or outside a
            Space. Never used in Private Chat.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <MemoryList
            memories={memories ?? EMPTY}
            enabled={enabled}
            emptyText={
              enabled
                ? "No global memories yet — chat outside a space and the extractor will start saving durable facts here."
                : "Global memory is off. Turn it on to start collecting facts."
            }
            onAdd={(content) =>
              addMemory({ content }).catch((e) => {
                notify("add memory", e);
                // Rethrow so MemoryList keeps the typed draft.
                throw e;
              })
            }
            onUpdate={(id, content) =>
              updateMemory(id, content).catch((e) => {
                notify("update memory", e);
                // Rethrow so MemoryList stays in edit mode.
                throw e;
              })
            }
            onRemove={(id) =>
              removeMemory(id).catch((e) => notify("remove memory", e))
            }
            onOpenChat={openChat}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function notify(action: string, e: unknown) {
  useToastStore.getState().push({
    kind: "error",
    title: `Couldn't ${action}`,
    body: e instanceof Error ? e.message : String(e),
  });
}
