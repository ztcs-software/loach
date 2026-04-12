import { create } from "zustand";
import {
  addSpaceFile,
  createSpace,
  deleteSpace,
  listSpaceFiles,
  listSpaces,
  removeSpaceFile,
  updateSpace,
} from "@/lib/tauri";
import type { Space, SpaceFile } from "@/types";

interface SpaceState {
  spaces: Space[];
  activeSpaceId: string | null;
  editingSpace: Space | null;
  viewingSpaceId: string | null;
  spaceFiles: Record<string, SpaceFile[]>;
  spacesExpanded: boolean;
  spaceFormOpen: boolean;

  hydrate: () => Promise<void>;
  selectSpace: (id: string | null) => void;
  createSpace: (
    name: string,
    description: string,
    instructions: string,
  ) => Promise<Space>;
  updateSpace: (
    id: string,
    name: string,
    description: string,
    instructions: string,
  ) => Promise<void>;
  deleteSpace: (id: string) => Promise<void>;
  setEditingSpace: (space: Space | null) => void;
  setSpaceFormOpen: (open: boolean) => void;
  setViewingSpace: (id: string | null) => void;
  toggleSpacesExpanded: () => void;

  loadSpaceFiles: (spaceId: string) => Promise<SpaceFile[]>;
  addFile: (
    spaceId: string,
    name: string,
    mime: string,
    kind: string,
    data: string,
    size: number,
  ) => Promise<SpaceFile>;
  removeFile: (fileId: string, spaceId: string) => Promise<void>;
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  activeSpaceId: null,
  editingSpace: null,
  viewingSpaceId: null,
  spaceFiles: {},
  spacesExpanded: false,
  spaceFormOpen: false,

  hydrate: async () => {
    try {
      const spaces = await listSpaces();
      set({ spaces });
    } catch (e) {
      console.error("space hydrate failed", e);
    }
  },

  selectSpace: (id) => {
    set({ activeSpaceId: id });
  },

  createSpace: async (name, description, instructions) => {
    const space = await createSpace({ name, description, instructions });
    set((s) => ({ spaces: [space, ...s.spaces] }));
    return space;
  },

  updateSpace: async (id, name, description, instructions) => {
    await updateSpace({ id, name, description, instructions });
    set((s) => ({
      spaces: s.spaces.map((sp) =>
        sp.id === id
          ? { ...sp, name, description, instructions, updated_at: Date.now() }
          : sp,
      ),
    }));
  },

  deleteSpace: async (id) => {
    await deleteSpace(id);
    set((s) => {
      const spaces = s.spaces.filter((sp) => sp.id !== id);
      const files = { ...s.spaceFiles };
      delete files[id];
      return {
        spaces,
        spaceFiles: files,
        activeSpaceId: s.activeSpaceId === id ? null : s.activeSpaceId,
      };
    });
  },

  setEditingSpace: (space) => set({ editingSpace: space }),
  setSpaceFormOpen: (open) => set({ spaceFormOpen: open }),
  setViewingSpace: (id) => set({ viewingSpaceId: id, activeSpaceId: id }),
  toggleSpacesExpanded: () =>
    set((s) => ({ spacesExpanded: !s.spacesExpanded })),

  loadSpaceFiles: async (spaceId) => {
    const files = await listSpaceFiles(spaceId);
    set((s) => ({ spaceFiles: { ...s.spaceFiles, [spaceId]: files } }));
    return files;
  },

  addFile: async (spaceId, name, mime, kind, data, size) => {
    const existing = get().spaceFiles[spaceId] ?? [];
    if (existing.length >= 12) throw new Error("Maximum 12 files per space");
    const file = await addSpaceFile({
      space_id: spaceId,
      name,
      mime,
      kind,
      data,
      size,
      position: existing.length,
    });
    set((s) => ({
      spaceFiles: {
        ...s.spaceFiles,
        [spaceId]: [...(s.spaceFiles[spaceId] ?? []), file],
      },
    }));
    return file;
  },

  removeFile: async (fileId, spaceId) => {
    await removeSpaceFile(fileId);
    set((s) => ({
      spaceFiles: {
        ...s.spaceFiles,
        [spaceId]: (s.spaceFiles[spaceId] ?? []).filter((f) => f.id !== fileId),
      },
    }));
  },
}));
