import { Brain, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToastStore, type Toast } from "@/stores/toastStore";

/** Renders the global toast stack in the bottom-right of the viewport.
 *  Mounted once at the App root so every store consumer can call
 *  `useToastStore.getState().push(…)` without thinking about placement.
 *  Each entry auto-dismisses on a kind-based timer (4s info-grade, 10s
 *  errors — handled by the store), holds while hovered or focused so the
 *  reader can finish, and the user can also click the × to dismiss early.
 *  The "memory" variant matches ChatGPT/Claude's "Saved to memory" pill —
 *  a soft indigo pill with a brain icon. */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const pause = useToastStore((s) => s.pause);
  const resume = useToastStore((s) => s.resume);
  const isMemory = toast.kind === "memory";
  const isError = toast.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      // Hold the auto-dismiss while the pointer is over the chip or focus
      // is inside it (keyboard users tabbing to Undo / ×) — a toast should
      // never vanish out from under someone who is engaging with it. The
      // capture-phase focus pair fires for any focusable descendant.
      onMouseEnter={() => pause(toast.id)}
      onMouseLeave={() => resume(toast.id)}
      onFocusCapture={() => pause(toast.id)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) resume(toast.id);
      }}
      className={cn(
        "pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-2xl border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur-md",
        "animate-in slide-in-from-bottom-2 fade-in duration-200",
        // Both tinted variants pair a light-mode-readable tone with the
        // original bright one under `dark:`. They previously carried only
        // the bright tone, which is sized for the dark backdrop — over a
        // 15% wash on the light theme the memory title measured 1.04:1 and
        // the error title 1.31:1, i.e. invisible. `text-destructive-
        // foreground` was the wrong token for the error case either way:
        // it's the on-solid-destructive colour, not an on-tint one.
        isMemory &&
          "border-indigo-400/30 bg-indigo-500/15 text-indigo-700 dark:text-indigo-100",
        isError &&
          "border-destructive/40 bg-destructive/15 text-red-700 dark:text-red-200",
        !isMemory && !isError &&
          "border-foreground/15 bg-foreground/[0.06] text-foreground/90",
      )}
    >
      {isMemory && (
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-200" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{toast.title}</div>
        {toast.body && (
          <div className="mt-0.5 line-clamp-2 text-xs text-foreground/70">
            {toast.body}
          </div>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toast.action?.onClick();
            onDismiss();
          }}
          className="shrink-0 self-center rounded-md bg-foreground/10 px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-foreground/[0.16]"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="shrink-0 rounded-md p-0.5 text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
