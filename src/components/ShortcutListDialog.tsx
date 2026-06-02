import { useMemo } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SHORTCUTS,
  formatShortcut,
  type ShortcutGroup,
} from "@/lib/shortcuts";

/**
 * Modal listing every global keyboard shortcut. Opened via Ctrl/Cmd+/.
 *
 * Visual layer reuses the shared `Dialog` primitive (which uses the
 * `glass-panel` class), so the modal automatically matches whichever
 * theme + background style the user has set — no extra theming work
 * needed for dark/light or solid/aurora.
 *
 * Rows are grouped (Navigation / Chat / Layout / Help) so the user can
 * scan by category instead of memorising the full list. Each row is
 * label + kbd chips; chips are stacked when a binding has multiple
 * accepted keys (e.g. Cmd+Shift+⌫ / Cmd+Shift+⌦ on macOS).
 */
const GROUP_ORDER: ShortcutGroup[] = ["Navigation", "Chat", "Layout", "Help"];

export function ShortcutListDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<ShortcutGroup, typeof SHORTCUTS>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const s of SHORTCUTS) {
      const list = map.get(s.group);
      if (list) list.push(s);
    }
    return map;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-foreground/65" aria-hidden />
            Keyboard shortcuts
          </DialogTitle>
          {/* Radix logs a console warning when a Dialog has no description,
              so we keep one — but hidden from sighted users. The list rows
              themselves communicate the modifier (⌘ vs Ctrl) clearly. */}
          <DialogDescription className="sr-only">
            List of keyboard shortcuts available in Loach.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {GROUP_ORDER.map((group) => {
            const items = grouped.get(group) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={group} className="space-y-1.5">
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-foreground/45">
                  {group}
                </h3>
                <ul className="overflow-hidden rounded-xl border border-foreground/[0.08] bg-foreground/[0.02]">
                  {items.map((spec, i) => (
                    <li
                      key={spec.action}
                      className={
                        i === 0
                          ? "flex items-center justify-between gap-3 px-3 py-2"
                          : "flex items-center justify-between gap-3 border-t border-foreground/[0.06] px-3 py-2"
                      }
                    >
                      <span className="min-w-0 truncate text-sm text-foreground/80">
                        {spec.label}
                      </span>
                      <ShortcutKbd spec={spec} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Renders a single shortcut as a row of kbd chips. When a spec accepts
 *  multiple keys (e.g. macOS delete-chat takes ⌫ or ⌦), both variants
 *  render separated by "or". */
function ShortcutKbd({ spec }: { spec: (typeof SHORTCUTS)[number] }) {
  if (spec.keys.length > 1) {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <KbdChip>
          {formatShortcut({ ...spec, keys: [spec.keys[0]] })}
        </KbdChip>
        <span className="text-[10px] text-foreground/35">or</span>
        <KbdChip>
          {formatShortcut({ ...spec, keys: [spec.keys[1]] })}
        </KbdChip>
      </span>
    );
  }
  return <KbdChip>{formatShortcut(spec)}</KbdChip>;
}

function KbdChip({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 shrink-0 items-center rounded-md border border-foreground/15 bg-foreground/[0.06] px-2 font-mono text-[11px] font-medium tracking-wide text-foreground/70 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
      {children}
    </kbd>
  );
}
