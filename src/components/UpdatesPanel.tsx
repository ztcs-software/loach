import { useEffect, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Markdown } from "@/components/Markdown";
import { UpdateProgressBar } from "@/components/UpdateProgress";
import {
  checkForUpdate,
  installPendingUpdate,
  isUpdaterSupported,
  type DownloadProgress,
  type UpdateInfo,
} from "@/lib/updater";
import { isTauri } from "@/lib/tauri";
import { useSettingsStore } from "@/stores/settingsStore";
import pkg from "../../package.json";

const GITHUB_RELEASES_URL = "https://github.com/ztcs-software/loach/releases/latest";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; progress: DownloadProgress }
  | { kind: "error"; message: string };

async function openExternal(url: string) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function UpdatesPanel() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const autoCheck = useSettingsStore((s) => s.auto_check_updates);
  const updateSetting = useSettingsStore((s) => s.update);

  useEffect(() => {
    void isUpdaterSupported().then(setSupported);
  }, []);

  // Unsupported install (dev build, plain binary, etc.) — show a friendly
  // fallback that points users at the GitHub release page instead of
  // letting them click into a guaranteed failure.
  if (supported === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-sm text-foreground/70">Current version</span>
          <span className="font-mono text-sm">v{pkg.version}</span>
        </div>
        <Separator />
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4 text-sm leading-relaxed text-foreground/75">
          In-app updates aren't available for this install. To upgrade, download
          the latest release manually.
        </div>
        <Button variant="outline" onClick={() => void openExternal(GITHUB_RELEASES_URL)} className="gap-2">
          <ExternalLink className="h-4 w-4" />
          Open releases
        </Button>
      </div>
    );
  }

  const onCheck = async () => {
    setState({ kind: "checking" });
    try {
      const info = await checkForUpdate();
      setState(info ? { kind: "available", info } : { kind: "uptodate" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onInstall = async () => {
    if (state.kind !== "available") return;
    const info = state.info;
    setState({ kind: "installing", info, progress: { downloaded: 0 } });
    try {
      await installPendingUpdate((progress) => {
        setState({ kind: "installing", info, progress });
      });
      // If we reach this line, relaunch() was awaited but the process is
      // already on its way down — nothing more to render.
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-3">
        <span className="text-sm text-foreground/70">Current version</span>
        <span className="font-mono text-sm">v{pkg.version}</span>
      </div>

      <Separator />

      {state.kind === "idle" && (
        <div>
          <Button onClick={onCheck} className="gap-2" disabled={supported === null}>
            <RefreshCw className="h-4 w-4" />
            Check for updates
          </Button>
        </div>
      )}

      {state.kind === "checking" && (
        <div className="flex items-center gap-2 text-sm text-foreground/75">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking for updates…
        </div>
      )}

      {state.kind === "uptodate" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-foreground/85">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            You're on the latest version.
          </div>
          <Button variant="outline" onClick={onCheck} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Check again
          </Button>
        </div>
      )}

      {state.kind === "available" && (
        <div className="space-y-4">
          <div className="text-sm text-foreground/85">
            <span className="font-medium">Loach v{state.info.version}</span> is
            available. You're on v{state.info.currentVersion}.
          </div>
          {state.info.notes && (
            <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-foreground/55">
                What's new
              </div>
              <Markdown content={state.info.notes} className="text-sm" />
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={onInstall} className="gap-2">
              <Download className="h-4 w-4" />
              Install update
            </Button>
            <Button variant="outline" onClick={onCheck} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Re-check
            </Button>
          </div>
        </div>
      )}

      {state.kind === "installing" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-foreground/85">
            <Loader2 className="h-4 w-4 animate-spin" />
            Downloading Loach v{state.info.version}…
          </div>
          <UpdateProgressBar progress={state.progress} />
          <p className="text-[11px] text-foreground/55">
            The app will restart automatically once the update is installed.
          </p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-sm text-foreground/85">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
            <span>Update failed: {state.message}</span>
          </div>
          <Button variant="outline" onClick={onCheck} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      )}

      <Separator />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5 text-foreground/60" />
            Auto-check for updates
          </Label>
          <p className="mt-1 text-[11px] text-foreground/50">
            Check for a newer release once each time Loach starts, and show a
            notice when one is available. Nothing is downloaded or installed
            until you confirm.
          </p>
        </div>
        <Switch
          checked={autoCheck}
          onCheckedChange={(next) => updateSetting("auto_check_updates", next)}
          className="shrink-0"
          aria-label={
            autoCheck
              ? "Disable auto-check for updates"
              : "Enable auto-check for updates"
          }
        />
      </div>
    </div>
  );
}
