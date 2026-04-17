import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";

export function SpaceForm() {
  const open = useSpaceStore((s) => s.spaceFormOpen);
  const setOpen = useSpaceStore((s) => s.setSpaceFormOpen);
  const doCreate = useSpaceStore((s) => s.createSpace);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setViewingSpacesList = useUIStore((s) => s.setViewingSpacesList);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleCancel = () => {
    setOpen(false);
    setName("");
    setDescription("");
    setError(null);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const space = await doCreate(name.trim(), description.trim(), "");
      setOpen(false);
      setName("");
      setDescription("");
      // Navigate to the new space view (also exits the Spaces browser if
      // the user opened the form from there).
      setViewingSpacesList(false);
      setViewingSpace(space.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={handleCancel}
      />

      {/* Content */}
      <div className="relative z-10 w-full max-w-lg px-6">
        <button
          onClick={handleCancel}
          className="mb-8 flex items-center gap-1.5 text-sm text-foreground/50 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Create a new Space
        </h1>
        <p className="mt-2 text-sm text-foreground/50">
          Spaces let you group chats with shared instructions and files.
        </p>

        <div className="mt-8 space-y-5">
          <div>
            <label
              htmlFor="space-name"
              className="mb-1.5 block text-sm font-medium text-foreground/70"
            >
              What are you working on?
            </label>
            <Input
              id="space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name your space"
              maxLength={60}
              autoFocus
              className="h-12 rounded-xl bg-foreground/[0.05] border-foreground/10 text-base"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
          </div>

          <div>
            <label
              htmlFor="space-desc"
              className="mb-1.5 block text-sm font-medium text-foreground/70"
            >
              What are you trying to achieve?
            </label>
            <Textarea
              id="space-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your project, goals, subject, etc..."
              className="min-h-[100px] rounded-xl bg-foreground/[0.05] border-foreground/10"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={handleCancel}
              className="rounded-xl px-5"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={saving || !name.trim()}
              className="rounded-xl px-5"
            >
              {saving ? "Creating..." : "Create space"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
