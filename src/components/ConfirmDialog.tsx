import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/* ─────────────────────────── Confirm / Prompt provider ───────────────────
 *
 * Drop-in replacement for `window.confirm(...)` and `window.prompt(...)`
 * so the desktop app stops painting the browser's native modal — which
 * looks alien on a Tauri window (it borrows the Chrome/Edge web shell
 * styling). The hook returns a Promise that resolves to the user's
 * answer, so existing call sites can keep their imperative shape:
 *
 *     const ok = await confirm({ title: "Delete?", body: "…" });
 *     if (ok) ...
 *
 * Mount `<ConfirmDialogHost />` ONCE at the app root (inside the unlocked
 * branch — destructive confirms aren't meaningful while the lock screen
 * is up). Anywhere below it, `useConfirm()` returns the imperative
 * `confirm` / `prompt` API.
 *
 * Visual layer reuses the existing `glass-panel` Dialog primitive so the
 * confirm modal blends with the rest of the app's chrome.
 * ─────────────────────────────────────────────────────────────────────── */

interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  /** Label for the affirmative button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the dismiss button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When true, the affirmative button gets the destructive (red) tint —
   *  signals deletions, factory resets, etc. */
  destructive?: boolean;
}

interface PromptRequest {
  title: string;
  body?: ReactNode;
  /** Pre-filled input value. */
  defaultValue?: string;
  /** Placeholder for the input. */
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmContextValue {
  /** Async replacement for `window.confirm`. Resolves to `true` if the
   *  user clicked the confirm button, `false` otherwise (Escape, X,
   *  Cancel, backdrop click). */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  /** Async replacement for `window.prompt`. Resolves to the entered
   *  string on confirm, or `null` on cancel. */
  prompt: (req: PromptRequest) => Promise<string | null>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/** Hook into the app-level confirm / prompt machinery. Throws if the
 *  `<ConfirmDialogHost />` provider isn't mounted, which would mean a
 *  caller is trying to ask before the app's unlocked layer rendered. */
export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error(
      "useConfirm must be used inside <ConfirmDialogHost> (mounted in App.tsx).",
    );
  }
  return ctx;
}

interface ActiveConfirm extends ConfirmRequest {
  kind: "confirm";
  resolve: (ok: boolean) => void;
}

interface ActivePrompt extends PromptRequest {
  kind: "prompt";
  resolve: (value: string | null) => void;
}

type Active = ActiveConfirm | ActivePrompt;

/** App-root host. Renders a single Radix Dialog that the imperative
 *  `confirm` / `prompt` APIs target. Keeping a single host instead of
 *  one Dialog per caller avoids the focus-trap thrash you'd get from
 *  spawning Dialogs ad-hoc. */
export function ConfirmDialogHost({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const [promptValue, setPromptValue] = useState("");
  // Stash the pending request's resolver in a ref so the dialog's
  // onOpenChange handler (which fires on backdrop / Escape close) can
  // always resolve with `false`/`null` — even if state has just changed.
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;

  /** Settle whatever request is on screen before a new one replaces it.
   *
   *  Installing a second request over a live one used to strand the first
   *  promise forever: its `await confirm(...)` never resolved, so the caller's
   *  continuation (and every closure it held) leaked. Reachable in practice —
   *  a keyboard shortcut firing a confirm while another is already open. The
   *  displaced request resolves as a dismissal, which is the safe answer for
   *  a destructive prompt nobody answered. */
  const settlePending = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    if (current.kind === "confirm") current.resolve(false);
    else current.resolve(null);
  }, []);

  const confirm = useCallback(
    (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        settlePending();
        setActive({ kind: "confirm", ...req, resolve });
      }),
    [settlePending],
  );

  const prompt = useCallback(
    (req: PromptRequest) =>
      new Promise<string | null>((resolve) => {
        settlePending();
        setPromptValue(req.defaultValue ?? "");
        setActive({ kind: "prompt", ...req, resolve });
      }),
    [settlePending],
  );

  const closeWith = (value: boolean | string | null) => {
    const current = activeRef.current;
    if (!current) return;
    if (current.kind === "confirm") {
      current.resolve(value === true);
    } else {
      current.resolve(typeof value === "string" ? value : null);
    }
    setActive(null);
    setPromptValue("");
  };

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}
      <Dialog
        open={active !== null}
        onOpenChange={(open) => {
          // Backdrop click, Escape, or X-button: treat as cancel.
          if (!open) closeWith(active?.kind === "prompt" ? null : false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{active?.title}</DialogTitle>
            {active?.body !== undefined && (
              <DialogDescription asChild>
                <div className="text-foreground/70">{active.body}</div>
              </DialogDescription>
            )}
          </DialogHeader>

          {active?.kind === "prompt" && (
            <input
              autoFocus
              type="text"
              value={promptValue}
              placeholder={active.placeholder}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  closeWith(promptValue);
                }
              }}
              className="w-full rounded-xl border border-foreground/15 bg-foreground/[0.04] px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-foreground/30 focus:outline-none"
            />
          )}

          <DialogFooter className="mt-2">
            <Button
              variant="ghost"
              onClick={() =>
                closeWith(active?.kind === "prompt" ? null : false)
              }
            >
              {active?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={
                active?.kind === "confirm" && active.destructive
                  ? "destructive"
                  : "default"
              }
              onClick={() =>
                closeWith(active?.kind === "prompt" ? promptValue : true)
              }
              autoFocus={active?.kind !== "prompt"}
            >
              {active?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
