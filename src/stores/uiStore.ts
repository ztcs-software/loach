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
  | "features"
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
  /** True while the sidebar is collapsed because a right panel opened on a
   *  narrow window (see App.tsx's squeeze effect), not because the user
   *  asked. Lets the panel-close path give the sidebar back, while a manual
   *  toggle takes ownership and cancels the pending restore. */
  sidebarAutoCollapsed: boolean;
  paramsOpen: boolean;
  settingsOpen: boolean;
  /** Visibility of the slash-command help dialog. Toggled by `/help` and
   *  by the dialog's close button. Lives on uiStore so the dispatcher
   *  can flip it without ChatInput having to own a local state. */
  helpOpen: boolean;
  /** Which Settings tab to show when the dialog opens. Defaults to `general`
   *  so the cold-open lands on the user-personalisation surface. */
  settingsTab: SettingsTab;
  /** Which icon-rail tab is active on the sidebar. */
  sidebarTab: SidebarTab;
  /** Session ids in most-recently-opened order, newest first. Feeds the
   *  Ctrl/Cmd+K palette's zero-query suggestions, which otherwise fall back
   *  to `updated_at DESC` — that surfaces recently *written to*, not
   *  recently *read*, so a chat you keep opening to re-read never rises.
   *  In-memory on purpose: on a cold start the `updated_at` fallback is
   *  already the right answer, so there's nothing worth persisting. */
  recentSessionIds: string[];
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
  /** One-shot flag: when true, the ChatHeader's model dropdown auto-opens on
   *  its next render with a session available, then clears itself. Used by
   *  the onboarding finish path so the user lands on a fresh chat with the
   *  model picker already expanded for selection. */
  pendingOpenModelPicker: boolean;
  /** One-shot flag: when true, the ChatHeader opens its "Export context"
   *  dialog on its next render with a session available, then clears itself.
   *  Set by the `/export` slash command, which can't reach the dialog's
   *  local state directly. Mirrors `pendingOpenModelPicker`. */
  pendingOpenExport: boolean;
  toggleSidebar: () => void;
  toggleParams: () => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Open the Settings dialog on a specific tab in one call — used by
   *  "Archive" in the sidebar rail. */
  openSettingsTab: (tab: SettingsTab) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Record that a chat was opened. Called by `chatStore.selectSession`. */
  noteSessionVisit: (sessionId: string) => void;
  setComposerDraft: (text: string) => void;
  insertComposerDraft: (text: string) => void;
  /** One-shot: seed both text and attachments into the composer. Used by
   *  Snippets' "Run" action. */
  primeComposer: (text: string, attachments: Attachment[]) => void;
  setSessionPersona: (sessionId: string, personaId: string) => void;
  setPendingPersona: (personaId: string | null) => void;
  consumePendingPersona: () => string | null;
  setSessionTone: (sessionId: string, toneId: string) => void;
  setPendingOpenModelPicker: (v: boolean) => void;
  consumePendingOpenModelPicker: () => boolean;
  setPendingOpenExport: (v: boolean) => void;
  consumePendingOpenExport: () => boolean;
}

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: true,
  sidebarAutoCollapsed: false,
  paramsOpen: false,
  settingsOpen: false,
  helpOpen: false,
  settingsTab: "general",
  sidebarTab: "chats",
  recentSessionIds: [],
  composerDraft: "",
  composerAttachments: [],
  composerInsertSeq: 0,
  personaIdBySession: {},
  pendingPersonaId: null,
  toneIdBySession: {},
  pendingOpenModelPicker: false,
  pendingOpenExport: false,
  toggleSidebar: () =>
    set((s) => ({ sidebarOpen: !s.sidebarOpen, sidebarAutoCollapsed: false })),
  toggleParams: () => set((s) => ({ paramsOpen: !s.paramsOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  openSettingsTab: (settingsTab) => set({ settingsTab, settingsOpen: true }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  noteSessionVisit: (sessionId) =>
    set((s) => {
      // Re-opening the chat that's already at the head is the common case
      // (selectSession fires on every open); bail without a new array so
      // subscribers don't re-render for a no-op. Capped — this is a
      // suggestion hint, not a history.
      if (s.recentSessionIds[0] === sessionId) return s;
      return {
        recentSessionIds: [
          sessionId,
          ...s.recentSessionIds.filter((id) => id !== sessionId),
        ].slice(0, 10),
      };
    }),
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
  setPendingOpenModelPicker: (v) => set({ pendingOpenModelPicker: v }),
  consumePendingOpenModelPicker: (): boolean => {
    const v = get().pendingOpenModelPicker;
    if (v) set({ pendingOpenModelPicker: false });
    return v;
  },
  setPendingOpenExport: (v) => set({ pendingOpenExport: v }),
  consumePendingOpenExport: (): boolean => {
    const v = get().pendingOpenExport;
    if (v) set({ pendingOpenExport: false });
    return v;
  },
}));
