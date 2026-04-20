import { create } from "zustand";
import type { Attachment } from "@/types";

/** Which section of the sidebar's right column is visible. Swapped by the
 *  narrow icon rail on the far left. */
export type SidebarTab = "chats" | "spaces" | "snippets" | "models";

/** Deep-link target when opening the Settings dialog. "archive" is the new
 *  home for the chat archive (previously a dedicated full-page view). */
export type SettingsTab =
  | "providers"
  | "prompt"
  | "appearance"
  | "archive"
  | "about";

interface UIState {
  sidebarOpen: boolean;
  paramsOpen: boolean;
  settingsOpen: boolean;
  /** Which Settings tab to show when the dialog opens. Reset to `providers`
   *  after the dialog closes so the next cold-open lands back on the
   *  default. */
  settingsTab: SettingsTab;
  /** Which icon-rail tab is active on the sidebar. */
  sidebarTab: SidebarTab;
  composerDraft: string;
  /** Files that should land in the composer when it next mounts / the primer
   *  seq bumps. Kept separate from `composerDraft` so suggestion chips (which
   *  only need text) don't have to touch attachments. */
  composerAttachments: Attachment[];
  composerInsertSeq: number;
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
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  paramsOpen: false,
  settingsOpen: false,
  settingsTab: "providers",
  sidebarTab: "chats",
  composerDraft: "",
  composerAttachments: [],
  composerInsertSeq: 0,
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
}));
