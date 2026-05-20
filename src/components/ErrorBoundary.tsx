import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Class component because React Error Boundaries require `componentDidCatch` /
// `getDerivedStateFromError`, which have no functional equivalent — `useErrorBoundary`
// from libraries like `react-error-boundary` is built around the same class
// underneath. Keeping our own avoids the new dep for what is a ~80-line
// component.
//
// Boundary placement strategy (see App.tsx / main.tsx):
//   - `scope="app"` lives at the very root (main.tsx) and around the LockScreen.
//     A crash here means the app cannot recover in place; the only escape is
//     a full reload, so we hide the "Try again" affordance.
//   - `scope="panel"` (default) wraps individual panels and dialogs. A crash
//     in one of these leaves the rest of the UI live; "Try again" re-mounts
//     just that subtree.
//
// The fallback uses `glass-panel` (the same surface dialogs use) and depends
// only on tailwind utility classes + the Button primitive — no toast / dialog /
// markdown machinery that might itself be the thing that crashed.

type Scope = "app" | "panel";

interface Props {
  children: ReactNode;
  /** Short human-readable label of what was crashing. Appears in the heading
   *  ("Something went wrong in {name}.") and in the clipboard report. */
  name?: string;
  scope?: Scope;
  /** Optional hook fired on "Try again". Useful when the parent holds state
   *  the boundary alone can't reset (e.g., clear an active selection). The
   *  boundary always clears its own error state regardless. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Sync render-phase update: flips the boundary into "show fallback" mode
    // before the next paint, so users never see the half-rendered broken tree.
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Stash the component stack so "Copy details" can include it. React only
    // hands it to us via this lifecycle, not via `getDerivedStateFromError`.
    this.setState({ info });
    const tag = this.props.name ? `[ErrorBoundary:${this.props.name}]` : "[ErrorBoundary]";
    // eslint-disable-next-line no-console
    console.error(tag, error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null, info: null, copied: false });
    this.props.onReset?.();
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleCopy = async () => {
    const { error, info } = this.state;
    if (!error) return;
    const stack = error.stack ?? "(no stack)";
    const componentStack = info?.componentStack?.trim() ?? "(no component stack)";
    const report = [
      "Loach error report",
      `Scope: ${this.props.name ?? "(unnamed)"}`,
      "",
      `${error.name}: ${error.message}`,
      "",
      "Stack:",
      stack,
      "",
      "Component stack:",
      componentStack,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      /* clipboard unavailable (Tauri sometimes restricts it on Linux) — silent.
         The console.error log above still has the same details for the user
         to retrieve via DevTools. */
    }
  };

  override render() {
    if (!this.state.error) return this.props.children;

    const isApp = (this.props.scope ?? "panel") === "app";
    const heading = isApp
      ? "Something went wrong."
      : `Something went wrong${this.props.name ? ` in ${this.props.name}` : ""}.`;
    const subheading = isApp
      ? "Loach hit an error it couldn't recover from. Reload to start fresh — your chats are saved."
      : "This part of the app crashed. Try again, or reload Loach if it keeps happening.";

    return (
      <div
        // `min-h-0` so the boundary doesn't enforce its own height inside a
        // flex parent (App.tsx's chat surface is `flex min-h-0 flex-1`). The
        // boundary should fill whatever slot it was given, not push it open.
        className={cn(
          "flex h-full min-h-0 w-full items-center justify-center px-6 py-8",
        )}
        role="alert"
      >
        <div className="glass-panel relative w-full max-w-md rounded-2xl p-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0 rounded-full bg-orange-500/10 p-2">
              <AlertTriangle className="h-5 w-5 text-orange-400" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground/90">
                {heading}
              </h2>
              <p className="mt-1 text-sm text-foreground/60">{subheading}</p>
              {/* Short error summary, truncated. The full stack + component
                  stack is available via "Copy details" — surfacing them
                  directly here would dominate the fallback for a user who
                  just wants to retry. */}
              <p
                className="mt-3 truncate font-mono text-xs text-foreground/45"
                title={`${this.state.error.name}: ${this.state.error.message}`}
              >
                {this.state.error.name}: {this.state.error.message}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {isApp ? (
                  <Button onClick={this.handleReload} size="sm" className="gap-2">
                    <RefreshCw className="h-3.5 w-3.5" />
                    Reload Loach
                  </Button>
                ) : (
                  <>
                    <Button onClick={this.handleReset} size="sm" className="gap-2">
                      <RefreshCw className="h-3.5 w-3.5" />
                      Try again
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={this.handleReload}
                      size="sm"
                      className="gap-2"
                    >
                      Reload Loach
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  onClick={() => void this.handleCopy()}
                  size="sm"
                  className="gap-2"
                >
                  {this.state.copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy details
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
