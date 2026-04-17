import { create } from "zustand";
import type { Attachment } from "@/types";

interface UIState {
  sidebarOpen: boolean;
  paramsOpen: boolean;
  settingsOpen: boolean;
  viewingSnippets: boolean;
  viewingArchive: boolean;
  composerDraft: string;
  /** Files that should land in the composer when it next mounts / the primer
   *  seq bumps. Kept separate from `composerDraft` so suggestion chips (which
   *  only need text) don't have to touch attachments. */
  composerAttachments: Attachment[];
  composerInsertSeq: number;
  toggleSidebar: () => void;
  toggleParams: () => void;
  setSettingsOpen: (open: boolean) => void;
  setViewingSnippets: (open: boolean) => void;
  setViewingArchive: (open: boolean) => void;
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
  viewingSnippets: false,
  viewingArchive: false,
  composerDraft: "",
  composerAttachments: [],
  composerInsertSeq: 0,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleParams: () => set((s) => ({ paramsOpen: !s.paramsOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setViewingSnippets: (viewingSnippets) => set({ viewingSnippets }),
  setViewingArchive: (viewingArchive) => set({ viewingArchive }),
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
