import { useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/Markdown";
import { UpdateProgressBar } from "@/components/UpdateProgress";
import {
  checkForUpdate,
  installPendingUpdate,
  isUpdaterSupported,
  type DownloadProgress,
  type UpdateInfo,
} from "@/lib/updater";
import { logger } from "@/lib/logger";
import { useSettingsStore } from "@/stores/settingsStore";

/* ─────────────────────── Launch-time update notice ───────────────────────
 *
 * Mounted once at the App root (below the lock / onboarding gates). When
 * the `auto_check_updates` setting is on, this asks the release server
 * once per launch whether a newer version exists and, if so, surfaces it
 * as a modal with the release notes and a one-click install.
 *
 * Deliberately silent otherwise: no "you're up to date" toast, and a
 * failed check only logs. The user opted into being *told about updates*,
 * not into launch-time network noise.
 * ───────────────────────────────────────────────────────────────────── */

type State =
  | { kind: "hidden" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; progress: DownloadProgress }
  | { kind: "error"; info: UpdateInfo; message: string };

export function UpdateAvailableDialog() {
  const hydrated = useSettingsStore((s) => s.hydrated);
  const [state, setState] = useState<State>({ kind: "hidden" });
  // One check per launch. Guarding with a ref (rather than subscribing to
  // `auto_check_updates`) means flipping the setting on mid-session doesn't
  // fire a check behind the open Settings dialog — it takes effect on the
  // next launch, which is what the setting's description promises.
  const checked = useRef(false);

  useEffect(() => {
    if (!hydrated || checked.current) return;
    checked.current = true;
    if (!useSettingsStore.getState().auto_check_updates) return;

    void (async () => {
      try {
        // Dev builds and plain binaries can't self-update — checking would
        // only ever surface an install button that fails.
        if (!(await isUpdaterSupported())) return;
        const info = await checkForUpdate();
        if (info) setState({ kind: "available", info });
      } catch (e) {
        logger.warn("auto update check failed", e);
      }
    })();
  }, [hydrated]);

  if (state.kind === "hidden") return null;

  const { info } = state;
  const installing = state.kind === "installing";

  const onInstall = async () => {
    setState({ kind: "installing", info, progress: { downloaded: 0 } });
    try {
      await installPendingUpdate((progress) => {
        setState({ kind: "installing", info, progress });
      });
      // Past this point `relaunch()` has been awaited and the process is on
      // its way down — nothing left to render.
    } catch (e) {
      setState({
        kind: "error",
        info,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape / backdrop / the X button. Ignored mid-download: closing
        // wouldn't stop the install, and the app would then restart out
        // from under a user who thought they'd dismissed it.
        if (!open && !installing) setState({ kind: "hidden" });
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Update available</DialogTitle>
          <DialogDescription>
            A new version of Loach is ready to install.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-foreground/70">Current version</span>
            <span className="font-mono text-sm text-foreground/85">
              v{info.currentVersion}
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <span className="text-sm text-foreground/70">New version</span>
            <span className="font-mono text-sm font-medium text-primary">
              v{info.version}
            </span>
          </div>
        </div>

        {info.notes && (
          <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-foreground/55">
              What's new
            </div>
            <div className="max-h-56 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              <Markdown content={info.notes} className="text-sm" />
            </div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex items-start gap-2 text-sm text-foreground/85">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
            <span>Update failed: {state.message}</span>
          </div>
        )}

        {installing ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-foreground/85">
              <Loader2 className="h-4 w-4 animate-spin" />
              Downloading Loach v{info.version}…
            </div>
            <UpdateProgressBar progress={state.progress} />
            <p className="text-[11px] text-foreground/55">
              The app will restart automatically once the update is installed.
            </p>
          </div>
        ) : (
          <DialogFooter className="mt-1">
            <Button variant="ghost" onClick={() => setState({ kind: "hidden" })}>
              Later
            </Button>
            <Button onClick={onInstall} className="gap-2" autoFocus>
              {state.kind === "error" ? (
                <>
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Update now
                </>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
