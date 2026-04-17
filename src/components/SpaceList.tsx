import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";

export function SpaceList() {
  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId);
  const selectSpace = useSpaceStore((s) => s.selectSpace);
  const expanded = useSpaceStore((s) => s.spacesExpanded);
  const toggle = useSpaceStore((s) => s.toggleSpacesExpanded);
  const setFormOpen = useSpaceStore((s) => s.setSpaceFormOpen);
  const removeSpace = useSpaceStore((s) => s.deleteSpace);

  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingSpacesList = useUIStore((s) => s.setViewingSpacesList);
  const setViewingSnippets = useUIStore((s) => s.setViewingSnippets);
  const setViewingArchive = useUIStore((s) => s.setViewingArchive);

  const handleSelectSpace = (id: string | null) => {
    setViewingSpacesList(false);
    setViewingSnippets(false);
    setViewingArchive(false);
    if (id) {
      // Open the full space view
      setViewingSpace(id);
    } else {
      selectSpace(null);
      setViewingSpace(null);
    }
  };

  const handleBrowseAll = () => {
    setViewingSpace(null);
    setViewingSnippets(false);
    setViewingArchive(false);
    setViewingSpacesList(true);
  };

  const handleCreate = () => {
    setFormOpen(true);
  };

  const handleEdit = (e: Event, space: (typeof spaces)[0]) => {
    e.stopPropagation();
    setViewingSpace(space.id);
  };

  const handleDelete = async (e: Event, id: string) => {
    e.stopPropagation();
    await removeSpace(id);
  };

  return (
    <div className="px-2 pb-2">
      <div className="flex items-center justify-between px-1 py-1">
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/35 hover:text-foreground/60 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Layers className="h-3 w-3" />
          Spaces
          {spaces.length > 0 && (
            <span className="ml-0.5 text-foreground/25">{spaces.length}</span>
          )}
        </button>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBrowseAll}
            aria-label="View all spaces"
            title="View all spaces"
            className="h-6 w-6 rounded-lg text-foreground/50 hover:text-foreground hover:bg-foreground/10"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleCreate}
            aria-label="New space"
            title="New space"
            className="h-6 w-6 rounded-lg text-foreground/50 hover:text-foreground hover:bg-foreground/10"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <ul className="mt-0.5 space-y-0.5">
          {spaces.map((space) => (
            <SpaceRow
              key={space.id}
              space={space}
              active={space.id === activeSpaceId}
              onSelect={() => handleSelectSpace(space.id)}
              onEdit={(e) => handleEdit(e, space)}
              onDelete={(e) => handleDelete(e, space.id)}
            />
          ))}

          {spaces.length === 0 && (
            <li className="px-3 py-1.5 text-[11px] text-foreground/30">
              No spaces yet
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function SpaceRow({
  space,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  space: { id: string; name: string; description: string };
  active: boolean;
  onSelect: () => void;
  onEdit: (e: Event) => void;
  onDelete: (e: Event) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-xl px-3 py-1.5 text-[12px] cursor-pointer transition-colors hover:bg-foreground/[0.07] hover:text-foreground text-foreground/60",
          active && "bg-foreground/[0.10] text-foreground",
        )}
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        <Layers className="h-3 w-3 shrink-0 opacity-50" />
        <span className="flex-1 truncate">{space.name}</span>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className="opacity-50 hover:opacity-100 rounded p-0.5 hover:bg-foreground/10"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem onSelect={(e) => onEdit(e)}>
              <Pencil className="h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => onDelete(e)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
