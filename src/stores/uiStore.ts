import { create } from "zustand";

interface UIState {
  sidebarOpen: boolean;
  paramsOpen: boolean;
  settingsOpen: boolean;
  composerDraft: string;
  composerInsertSeq: number;
  toggleSidebar: () => void;
  toggleParams: () => void;
  setSettingsOpen: (open: boolean) => void;
  setComposerDraft: (text: string) => void;
  insertComposerDraft: (text: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  paramsOpen: false,
  settingsOpen: false,
  composerDraft: "",
  composerInsertSeq: 0,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleParams: () => set((s) => ({ paramsOpen: !s.paramsOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  insertComposerDraft: (text) =>
    set((s) => ({
      composerDraft: text,
      composerInsertSeq: s.composerInsertSeq + 1,
    })),
}));
