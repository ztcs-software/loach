//! Settings -> Data: export / import / erase.
//!
//! Split out of SettingsDialog, which had grown past 3,000 lines. These
//! pieces only ever talked to each other and the stores, so they move as a
//! unit: the panel itself, its rows, the two-step erase dialog, and the
//! import-confirmation sheet.

import type { ImportStats } from "@/types";
import { AlertTriangle, Archive, Download, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StorageTile } from "@/components/settings/StorageTile";
import { cn } from "@/lib/utils";
import { type DestructiveAuth, type LockMethod, archiveAllSessions, exportDataJson, factoryReset, importDataWithDialog, isTauri, saveTextToFile, wipeUserData } from "@/lib/tauri";
import { useChatStore } from "@/stores/chatStore";
import { useConfirm } from "@/components/ConfirmDialog";
import { useEffect, useRef, useState } from "react";
import { useSecurityStore } from "@/stores/securityStore";

type BusyKind = "export" | "import" | "archive-all" | null;

export function DataPanel() {
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState<BusyKind>(null);
  const [message, setMessage] = useState<{
    tone: "info" | "error";
    text: string;
  } | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [importPromptOpen, setImportPromptOpen] = useState(false);
  // Whether the app lock is configured. The destructive flows only need to
  // surface a credential prompt when this is true; an unlocked install
  // doesn't gate the action.
  const lockStatus = useSecurityStore((s) => s.status);

  // Track every timeout this panel arms so we can clear them all when the
  // dialog closes (which unmounts this component). Without this, a 900 ms
  // reload-timer survives the unmount and fires later, potentially while
  // the user has moved on to other work. The destructive flows below
  // schedule both a "flash a toast then reload" and the toast's own
  // auto-clear; clearing all of them on unmount keeps closure references
  // from outliving the dialog.
  const pendingTimers = useRef<Set<number>>(new Set());
  const scheduleTimer = (cb: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      pendingTimers.current.delete(id);
      cb();
    }, ms);
    pendingTimers.current.add(id);
    return id;
  };
  useEffect(
    () => () => {
      // On unmount: cancel the cosmetic timers we armed (the `flash`
      // auto-clears) so their closures don't outlive the dialog.
      for (const id of pendingTimers.current) {
        window.clearTimeout(id);
      }
      pendingTimers.current.clear();
    },
    [],
  );

  /** Post-wipe / post-import reload. Deliberately NOT routed through
   *  `scheduleTimer`: this panel unmounts on any Settings tab switch and on
   *  Escape, both of which are reachable inside the 900 ms window — and a
   *  cancelled reload leaves every store holding pre-wipe data over a DB
   *  that has been emptied or replaced. The small delay only exists so the
   *  success message is visible first. */
  const reloadAfterDestructiveAction = () => {
    window.setTimeout(() => {
      window.location.reload();
    }, 900);
  };

  // A tiny toast-lite: the feedback message auto-clears after 5s so long-
  // running exports don't leave stale success chips behind when the user
  // pokes Export a second time.
  const flash = (tone: "info" | "error", text: string) => {
    setMessage({ tone, text });
    scheduleTimer(() => {
      setMessage((m) => (m && m.text === text ? null : m));
    }, 5000);
  };

  const handleExport = async () => {
    if (!isTauri) {
      flash("error", "Export requires the desktop app.");
      return;
    }
    setBusy("export");
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const payload = await exportDataJson();
      // Backend owns both the dialog and the write — see saveTextToFile.
      const path = await saveTextToFile({
        content: payload,
        default_path: `loach-export-${stamp}.json`,
        filters: [{ name: "Loach export", extensions: ["json"] }],
      });
      if (!path) {
        setBusy(null);
        return; // user cancelled the save dialog
      }
      flash("info", `Exported to ${path}`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    if (!isTauri) {
      flash("error", "Import requires the desktop app.");
      return;
    }
    setImportPromptOpen(true);
  };

  // Stage 2 of import: armed by the ImportConfirm dialog, runs after the
  // user has confirmed AND (when a lock is configured) supplied their
  // current credentials. The Rust side handles the dialog and the read.
  const runImport = async (auth?: DestructiveAuth) => {
    setBusy("import");
    try {
      const stats = await importDataWithDialog(auth);
      if (stats === null) {
        // User cancelled the file picker on the backend side.
        setBusy(null);
        return;
      }
      flash("info", formatImportSummary(stats));
      reloadAfterDestructiveAction();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const handleArchiveAll = async () => {
    if (!isTauri) {
      flash("error", "Archive requires the desktop app.");
      return;
    }
    const live = useChatStore
      .getState()
      .sessions.filter((s) => !s.archived_at).length;
    if (live === 0) {
      flash("info", "No live chats to archive.");
      return;
    }
    const confirmed = await confirm({
      title: `Archive ${live} live chat${live === 1 ? "" : "s"}?`,
      body: "You can unarchive any of them later from Settings → Archive.",
      confirmLabel: "Archive all",
    });
    if (!confirmed) return;

    setBusy("archive-all");
    try {
      const n = await archiveAllSessions();
      // Re-hydrate the chat store so the sidebar collapses the now-archived
      // sessions and a fresh blank chat is created for the user to land in.
      await useChatStore.getState().hydrate();
      flash("info", `Archived ${n} chat${n === 1 ? "" : "s"}.`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <StorageTile />

      <div className="mt-5 divide-y divide-foreground/[0.06] rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
        <DataRow
          icon={<Download className="h-4 w-4" />}
          title="Export data"
          description="Save a full database dump (including chats, spaces, snippets and settings) to a JSON file."
          action={
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={busy !== null}
              className="shrink-0"
            >
              {busy === "export" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Exporting…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  Export
                </>
              )}
            </Button>
          }
        />
        <DataRow
          icon={<Upload className="h-4 w-4" />}
          title="Import data"
          description="Restore from a previously exported JSON dump. Replaces everything in the current database."
          action={
            <Button
              variant="outline"
              onClick={handleImport}
              disabled={busy !== null}
              className="shrink-0"
            >
              {busy === "import" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5" />
                  Import
                </>
              )}
            </Button>
          }
        />
        <DataRow
          icon={<Archive className="h-4 w-4" />}
          title="Archive all chats"
          description="Move every live chat to the archive. Chat history isn't deleted as individual chats may be unarchived at any time."
          action={
            <Button
              variant="outline"
              onClick={handleArchiveAll}
              disabled={busy !== null}
              className="shrink-0"
            >
              {busy === "archive-all" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Archiving…
                </>
              ) : (
                <>
                  <Archive className="h-3.5 w-3.5" />
                  Archive all
                </>
              )}
            </Button>
          }
        />
      </div>

      {/* Danger zone — a dedicated visually-distinct card so Erase can't be
          mistaken for the more routine Export / Import rows. */}
      <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/[0.06] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-[13.5px] font-semibold text-foreground">
              Erase &amp; Reset
            </h4>
            <p className="mt-1 text-[12px] leading-relaxed text-foreground/60">
              Permanently delete your data, or factory-reset the app to its
              default state. This operation cannot be undone. Consider
              performing an export first.
            </p>
          </div>
          <Button
            variant="destructive"
            onClick={() => setEraseOpen(true)}
            disabled={busy !== null}
            className="shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Erase…
          </Button>
        </div>
      </div>

      {message && (
        <div
          role="status"
          className={cn(
            "mt-4 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
            message.tone === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-foreground/10 bg-foreground/[0.04] text-foreground/75",
          )}
        >
          {message.text}
        </div>
      )}

      <EraseDialog
        open={eraseOpen}
        onOpenChange={setEraseOpen}
        lockConfigured={lockStatus.configured}
        lockMethod={lockStatus.method}
        pinLength={lockStatus.pin_length}
        onDone={(text) => {
          flash("info", text);
          // Full reload so every zustand store re-hydrates from the now-
          // empty DB.
          reloadAfterDestructiveAction();
        }}
      />

      <ImportConfirm
        open={importPromptOpen}
        onOpenChange={setImportPromptOpen}
        lockConfigured={lockStatus.configured}
        lockMethod={lockStatus.method}
        pinLength={lockStatus.pin_length}
        onConfirm={async (auth) => {
          setImportPromptOpen(false);
          await runImport(auth);
        }}
      />
    </>
  );
}

/** One row in the Data tab's action list. Kept purely presentational so the
 *  busy / disabled logic stays in `DataPanel`. */
function DataRow({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-foreground/75">
          {icon}
        </div>
        <div className="min-w-0">
          <h4 className="text-[13.5px] font-medium text-foreground">{title}</h4>
          <p className="mt-1 text-[12px] leading-relaxed text-foreground/55">
            {description}
          </p>
        </div>
      </div>
      {action}
    </div>
  );
}

function formatImportSummary(s: ImportStats): string {
  const parts: string[] = [];
  if (s.sessions) parts.push(`${s.sessions} chat${s.sessions === 1 ? "" : "s"}`);
  if (s.messages) parts.push(`${s.messages} message${s.messages === 1 ? "" : "s"}`);
  if (s.spaces) parts.push(`${s.spaces} space${s.spaces === 1 ? "" : "s"}`);
  if (s.snippets) parts.push(`${s.snippets} snippet${s.snippets === 1 ? "" : "s"}`);
  if (s.snippet_variables)
    parts.push(`${s.snippet_variables} variable${s.snippet_variables === 1 ? "" : "s"}`);
  if (s.mcp_servers)
    parts.push(`${s.mcp_servers} MCP server${s.mcp_servers === 1 ? "" : "s"}`);
  const body = parts.length > 0 ? parts.join(" · ") : "0 records";
  return `Imported ${body}. Reloading…`;
}

/* ───────────────── Erase & Reset confirmation dialog ─────────────────
 *
 * Two-step destructive UI:
 *   1. User picks a mode — "my data only" vs "factory reset" — via a
 *      pair of card-style radio options.
 *   2. User types YES (case-insensitive "yes" accepted) to unlock the
 *      red "Erase" button. Both the radio choice and the text input
 *      reset on every re-open so a closed-then-reopened dialog always
 *      starts clean.
 * ─────────────────────────────────────────────────────────────────── */

type EraseMode = "user-data" | "factory-reset";

function EraseDialog({
  open,
  onOpenChange,
  lockConfigured,
  lockMethod,
  pinLength,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When true the backend will reject the call without current credentials,
   *  so the dialog grows a PIN / password section. */
  lockConfigured: boolean;
  lockMethod: LockMethod | null;
  pinLength: number | null;
  onDone: (successMessage: string) => void;
}) {
  const [mode, setMode] = useState<EraseMode>("user-data");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");

  const usesPin =
    lockConfigured && (lockMethod === "pin" || lockMethod === "both");
  const usesPassword =
    lockConfigured && (lockMethod === "password" || lockMethod === "both");
  const requiredPinLen = (pinLength ?? 4) as 4 | 6 | 8;

  // Reset the form whenever the dialog is opened — never carry state across
  // mount/unmount cycles for a destructive action.
  useEffect(() => {
    if (open) {
      setMode("user-data");
      setConfirmText("");
      setPin("");
      setPassword("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const credsOk =
    (!usesPin || pin.length === requiredPinLen) &&
    (!usesPassword || password.length > 0);
  const armed = confirmText.trim().toUpperCase() === "YES" && credsOk;

  const handleConfirm = async () => {
    if (!armed) return;
    const auth: DestructiveAuth | undefined = lockConfigured
      ? {
          pin: usesPin ? pin : undefined,
          password: usesPassword ? password : undefined,
        }
      : undefined;
    setBusy(true);
    setError(null);
    try {
      if (mode === "user-data") {
        await wipeUserData(auth);
        onDone("All chats, spaces, snippets, and MCP servers deleted. Reloading…");
      } else {
        await factoryReset(auth);
        onDone("Loach has been reset to factory defaults. Reloading…");
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-lg gap-5">
        <div>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Erase &amp; Reset
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] text-foreground/60">
            Choose what to erase. Nothing happens until you type{" "}
            <span className="font-mono font-semibold text-foreground/80">YES</span>{" "}
            and press the red button.
          </DialogDescription>
        </div>

        <div className="space-y-2.5">
          <EraseOption
            selected={mode === "user-data"}
            onClick={() => setMode("user-data")}
            title="Remove my data"
            body={
              <>
                Delete all <strong>chats</strong>, <strong>spaces</strong>,{" "}
                <strong>snippets</strong>, and <strong>MCP servers</strong>.
                Keeps your settings (theme, provider URLs, system prompt) and
                your stored OpenAI API key.
              </>
            }
          />
          <EraseOption
            selected={mode === "factory-reset"}
            onClick={() => setMode("factory-reset")}
            title="Factory reset"
            emphasis="danger"
            body={
              <>
                Everything above, <strong>plus</strong> all app settings and
                your stored <strong>OpenAI API key</strong>. The app will
                look like a fresh install.
              </>
            }
          />
        </div>

        <div>
          <Label htmlFor="erase-confirm" className="text-[12px]">
            Type <span className="font-mono font-semibold">YES</span> to confirm
          </Label>
          <Input
            id="erase-confirm"
            className="mt-1.5 font-mono"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="YES"
            disabled={busy}
          />
        </div>

        {lockConfigured && (usesPin || usesPassword) && (
          <div className="space-y-2.5 rounded-xl border border-foreground/10 bg-foreground/[0.025] p-3">
            <p className="text-[12px] text-foreground/65">
              The app lock is configured — enter your current credentials to
              authorise this destructive action.
            </p>
            {usesPin && (
              <div>
                <Label htmlFor="erase-verify-pin" className="text-[12px]">Current PIN</Label>
                <Input
                  id="erase-verify-pin"
                  className="mt-1.5"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  maxLength={requiredPinLen}
                  value={pin}
                  onChange={(e) =>
                    setPin(
                      e.target.value
                        .replace(/\D/g, "")
                        .slice(0, requiredPinLen),
                    )
                  }
                  placeholder={"•".repeat(requiredPinLen)}
                  disabled={busy}
                />
              </div>
            )}
            {usesPassword && (
              <div>
                <Label htmlFor="erase-verify-password" className="text-[12px]">Current password</Label>
                <Input
                  id="erase-verify-password"
                  className="mt-1.5"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!armed || busy}
            onClick={handleConfirm}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Erasing…
              </>
            ) : mode === "factory-reset" ? (
              <>
                <RotateCcw className="h-3.5 w-3.5" />
                Factory reset
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                Erase my data
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EraseOption({
  selected,
  onClick,
  title,
  body,
  emphasis,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body: React.ReactNode;
  emphasis?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group flex w-full items-start gap-3 rounded-2xl border-2 p-3.5 text-left transition-all",
        selected
          ? emphasis === "danger"
            ? "border-destructive bg-destructive/[0.07]"
            : "border-primary bg-primary/[0.06]"
          : "border-foreground/10 hover:border-foreground/25 hover:bg-foreground/[0.02]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-all",
          selected
            ? emphasis === "danger"
              ? "border-destructive"
              : "border-primary"
            : "border-foreground/30 group-hover:border-foreground/50",
        )}
        aria-hidden
      >
        {selected && (
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              emphasis === "danger" ? "bg-destructive" : "bg-primary",
            )}
          />
        )}
      </span>
      <div className="min-w-0">
        <div
          className={cn(
            "text-[13px] font-semibold",
            selected && emphasis === "danger"
              ? "text-destructive"
              : "text-foreground",
          )}
        >
          {title}
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/60">
          {body}
        </p>
      </div>
    </button>
  );
}

/* ───────────────── Import confirmation dialog ─────────────────
 *
 * Replaces the old `window.confirm("…replaces everything…")` prompt. Two
 * jobs:
 *
 *   1. Explain that import is destructive (replaces every table).
 *   2. When the app lock is configured, collect the current credentials so
 *      the backend can verify them BEFORE it even opens the file picker.
 *      A compromised UI cannot bypass this — the backend rejects the call
 *      if the credentials don't match the keyring blob.
 * ─────────────────────────────────────────────────────────────── */

function ImportConfirm({
  open,
  onOpenChange,
  lockConfigured,
  lockMethod,
  pinLength,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lockConfigured: boolean;
  lockMethod: LockMethod | null;
  pinLength: number | null;
  onConfirm: (auth?: DestructiveAuth) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const usesPin =
    lockConfigured && (lockMethod === "pin" || lockMethod === "both");
  const usesPassword =
    lockConfigured && (lockMethod === "password" || lockMethod === "both");
  const requiredPinLen = (pinLength ?? 4) as 4 | 6 | 8;

  useEffect(() => {
    if (open) {
      setPin("");
      setPassword("");
      setBusy(false);
    }
  }, [open]);

  const credsOk =
    (!usesPin || pin.length === requiredPinLen) &&
    (!usesPassword || password.length > 0);

  const handleConfirm = async () => {
    if (!credsOk) return;
    const auth: DestructiveAuth | undefined = lockConfigured
      ? {
          pin: usesPin ? pin : undefined,
          password: usesPassword ? password : undefined,
        }
      : undefined;
    setBusy(true);
    await onConfirm(auth);
    // Parent flips `open` to false on success / cancel; we just stop here.
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md gap-5">
        <div>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Upload className="h-4 w-4 text-foreground/70" />
            Import data
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] text-foreground/60">
            Importing will replace ALL chats, spaces, snippets, MCP servers,
            and settings with the contents of the file you select next. Your
            stored OpenAI API key is not touched.
          </DialogDescription>
        </div>

        {lockConfigured && (usesPin || usesPassword) && (
          <div className="space-y-2.5 rounded-xl border border-foreground/10 bg-foreground/[0.025] p-3">
            <p className="text-[12px] text-foreground/65">
              The app lock is configured — enter your current credentials to
              continue.
            </p>
            {usesPin && (
              <div>
                <Label htmlFor="reset-verify-pin" className="text-[12px]">Current PIN</Label>
                <Input
                  id="reset-verify-pin"
                  className="mt-1.5"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  maxLength={requiredPinLen}
                  value={pin}
                  onChange={(e) =>
                    setPin(
                      e.target.value
                        .replace(/\D/g, "")
                        .slice(0, requiredPinLen),
                    )
                  }
                  placeholder={"•".repeat(requiredPinLen)}
                  disabled={busy}
                />
              </div>
            )}
            {usesPassword && (
              <div>
                <Label htmlFor="reset-verify-password" className="text-[12px]">Current password</Label>
                <Input
                  id="reset-verify-password"
                  className="mt-1.5"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            disabled={!credsOk || busy}
            onClick={() => void handleConfirm()}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Choose file…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                Choose file…
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
