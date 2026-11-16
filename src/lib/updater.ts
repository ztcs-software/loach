import { create } from "zustand";
import { isTauri, updaterSupported } from "@/lib/tauri";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  notes?: string;
}

export interface DownloadProgress {
  downloaded: number;
  total?: number;
}

// The `check()` call returns an opaque handle that carries the signed
// download URL and signature. We stash the most recent one so the "Install"
// click doesn't have to re-fetch latest.json — and so we install exactly the
// version we showed the user release notes for.
let pendingUpdate: { downloadAndInstall: (cb: (e: unknown) => void) => Promise<void> } | null = null;

export async function isUpdaterSupported(): Promise<boolean> {
  if (!isTauri) return false;
  // Delegates to the typed wrapper in `lib/tauri.ts` so we stay
  // consistent with every other IPC call. A bad command name there
  // throws at runtime, not silently — which the old raw `invoke()`
  // + `catch { return false }` here would have hidden indefinitely.
  try {
    return await updaterSupported();
  } catch {
    return false;
  }
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  // Mid-install a fresh check would replace the staged update being
  // downloaded; what's installing is the answer.
  const running = useUpdateInstall.getState().install;
  if (running) return running.info;
  const [{ check }, { getVersion }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/api/app"),
  ]);
  const currentVersion = await getVersion();
  const update = await check();
  if (!update) {
    pendingUpdate = null;
    return null;
  }
  pendingUpdate = update as unknown as typeof pendingUpdate;
  return {
    version: update.version,
    currentVersion,
    date: update.date ?? undefined,
    notes: update.body ?? undefined,
  };
}

/** The install under way: what's being installed and how far its download
 *  has got. Kept here, not in the surface that started it, because a lock
 *  unmounts Settings and the launch notice mid-download: remounted, they
 *  offered "Check for updates" as if nothing were running, and Install again
 *  started a second download over the first. */
export interface UpdateInstall {
  info: UpdateInfo;
  progress: DownloadProgress;
}

export const useUpdateInstall = create<{ install: UpdateInstall | null }>(() => ({ install: null }));

/** True while `installPendingUpdate` is downloading/installing.
 *
 *  Once a download is under way it cannot be stopped, and the app restarts
 *  itself when it finishes — so any surface that could otherwise be
 *  dismissed mid-install has to refuse, or the restart lands on a user who
 *  believes they cancelled. */
export function isUpdateInstalling(): boolean {
  return useUpdateInstall.getState().install !== null;
}

/** Download and install the staged update (`info` is what was shown for it),
 *  then relaunch. Progress goes to {@link useUpdateInstall}. */
export async function installPendingUpdate(info: UpdateInfo): Promise<void> {
  if (!pendingUpdate) {
    throw new Error("No update is staged. Run a check first.");
  }
  if (isUpdateInstalling()) {
    throw new Error("An update is already being installed.");
  }
  let downloaded = 0;
  let total: number | undefined;
  const onProgress = (progress: DownloadProgress) =>
    useUpdateInstall.setState({ install: { info, progress } });
  onProgress({ downloaded: 0 });
  try {
    await pendingUpdate.downloadAndInstall((event: unknown) => {
      const e = event as { event: string; data?: { contentLength?: number; chunkLength?: number } };
      if (e.event === "Started") {
        total = e.data?.contentLength;
        onProgress({ downloaded: 0, total });
      } else if (e.event === "Progress") {
        downloaded += e.data?.chunkLength ?? 0;
        onProgress({ downloaded, total });
      } else if (e.event === "Finished") {
        onProgress({ downloaded: total ?? downloaded, total });
      }
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    // Only clear on failure — of the download, the install or the relaunch:
    // on success the relaunch tears the process down, and leaving the flag
    // set keeps every dismissal guard closed for the moments between
    // "download finished" and the window disappearing. A relaunch that
    // failed left it set, and Settings refused Esc and ✕ for the session.
    useUpdateInstall.setState({ install: null });
    throw e;
  }
}
