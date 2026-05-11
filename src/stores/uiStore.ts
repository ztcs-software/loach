import { create } from "zustand";
import type { Attachment } from "@/types";

/** Which section of the sidebar's right column is visible. Swapped by the
 *  narrow icon rail on the far left. */
export type SidebarTab = "chats" | "spaces" | "snippets" | "models";

/** Deep-link target when opening the Settings dialog. "archive" is the new
 *  home for the chat archive (previously a dedicated full-page view). */
export type SettingsTab =
  | "general"
  | "providers"
  | "tools"
  | "appearance"
  | "mcp"
  | "archive"
  | "data"
  | "security"
  | "updates"
  | "about";

interface UIState {
  sidebarOpen: boolean;
  paramsOpen: boolean;
  settingsOpen: boolean;
  /** Which Settings tab to show when the dialog opens. Defaults to `general`
   *  so the cold-open lands on the user-personalisation surface. */
  settingsTab: SettingsTab;
  /** Which icon-rail tab is active on the sidebar. */
  sidebarTab: SidebarTab;
  composerDraft: string;
  /** Files that should land in the composer when it next mounts / the primer
   *  seq bumps. Kept separate from `composerDraft` so suggestion chips (which
   *  only need text) don't have to touch attachments. */
  composerAttachments: Attachment[];
  composerInsertSeq: number;
  /** Persona ID applied to a given chat session. Selected from the composer's
   *  plus-menu; mirrors the session's `system_prompt` but is tracked separately
   *  so the UI can show the persona name even after a reload. Not persisted
   *  across launches by design — the seed prompt lives on the session itself,
   *  and forgetting which preset produced it is an acceptable cost for v1. */
  personaIdBySession: Record<string, string>;
  /** Persona to apply to the next session created (welcome-screen flow, where
   *  no session exists yet when the user opens the menu). Consumed by
   *  chatStore.newSession on session creation. */
  pendingPersonaId: string | null;
  /** Per-chat tone override. When unset, the chat falls back to
   *  `settings.default_tone_id`. The tone fragment is composed into the
   *  effective system prompt at send time (chatStore), not stored on the
   *  session itself — that way the System-prompt textarea only ever shows the
   *  persona / user-authored prompt and tones don't compete with manual
   *  edits. */
  toneIdBySession: Record<string, string>;
  toggleSidebar: () => void;
  toggleParams: () => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Open the Settings dialog on a specific tab in one call — used by
   *  "Archive" in the sidebar rail. */
  openSettingsTab: (tab: SettingsTab) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setComposerDraft: (text: string) => void;
  insertComposerDraft: (text: string) => void;
  /** One-shot: seed both text and attachments into the composer. Used by
   *  Snippets' "Run" action. */
  primeComposer: (text: string, attachments: Attachment[]) => void;
  setSessionPersona: (sessionId: string, personaId: string) => void;
  setPendingPersona: (personaId: string | null) => void;
  consumePendingPersona: () => string | null;
  setSessionTone: (sessionId: string, toneId: string) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: true,
  paramsOpen: false,
  settingsOpen: false,
  settingsTab: "general",
  sidebarTab: "chats",
  composerDraft: "",
  composerAttachments: [],
  composerInsertSeq: 0,
  personaIdBySession: {},
  pendingPersonaId: null,
  toneIdBySession: {},
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleParams: () => set((s) => ({ paramsOpen: !s.paramsOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  openSettingsTab: (settingsTab) => set({ settingsTab, settingsOpen: true }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  insertComposerDraft: (text) =>
    set((s) => ({
      composerDraft: text,
      composerAttachments: [],
      composerInsertSeq: s.composerInsertSeq + 1,
    })),
  primeComposer: (text, attachments) =>
    set((s) => ({
      composerDraft: text,
      composerAttachments: attachments,
      composerInsertSeq: s.composerInsertSeq + 1,
    })),
  setSessionPersona: (sessionId, personaId) =>
    set((s) => ({
      personaIdBySession: { ...s.personaIdBySession, [sessionId]: personaId },
    })),
  setPendingPersona: (pendingPersonaId) => set({ pendingPersonaId }),
  consumePendingPersona: (): string | null => {
    const id = get().pendingPersonaId;
    if (id) set({ pendingPersonaId: null });
    return id;
  },
  setSessionTone: (sessionId, toneId) =>
    set((s) => ({
      toneIdBySession: { ...s.toneIdBySession, [sessionId]: toneId },
    })),
}));
