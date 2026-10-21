import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSpaceStore } from "@/stores/spaceStore";
import { dialogEnter } from "@/lib/shortcuts";

export function SpaceForm() {
  const open = useSpaceStore((s) => s.spaceFormOpen);
  const setOpen = useSpaceStore((s) => s.setSpaceFormOpen);
  const doCreate = useSpaceStore((s) => s.createSpace);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setError(null);
  };

  const handleCancel = () => {
    setOpen(false);
    reset();
  };

  const canCreate = !saving && !!name.trim();

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
      reset();
      setViewingSpace(space.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : handleCancel())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Space</DialogTitle>
          <DialogDescription>
            Spaces let you group chats with shared instructions and sources.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <Field label="Name">
            <Input
              id="space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void handleCreate(), { ready: canCreate })}
              placeholder="e.g. Website redesign"
              maxLength={60}
              autoFocus
            />
          </Field>
          <Field label="Description" optional>
            <Textarea
              id="space-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => dialogEnter(e, () => void handleCreate(), { ready: canCreate })}
              placeholder="Describe your project, goals, subject…"
              className="min-h-[88px] rounded-2xl border-foreground/10 bg-foreground/[0.05]"
            />
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={handleCancel}
            className="rounded-lg"
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canCreate}
            className="rounded-lg"
          >
            {saving ? "Creating…" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
