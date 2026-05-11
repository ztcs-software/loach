import { isTauri } from "@/lib/tauri";

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
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("updater_supported");
  } catch {
    return false;
  }
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
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

export async function installPendingUpdate(
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error("No update is staged. Run a check first.");
  }
  let downloaded = 0;
  let total: number | undefined;
  await pendingUpdate.downloadAndInstall((event: unknown) => {
    const e = event as { event: string; data?: { contentLength?: number; chunkLength?: number } };
    if (e.event === "Started") {
      total = e.data?.contentLength;
      onProgress?.({ downloaded: 0, total });
    } else if (e.event === "Progress") {
      downloaded += e.data?.chunkLength ?? 0;
      onProgress?.({ downloaded, total });
    } else if (e.event === "Finished") {
      onProgress?.({ downloaded: total ?? downloaded, total });
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
