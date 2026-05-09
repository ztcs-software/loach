import { useState } from "react";
import { Loader2, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useToastStore } from "@/stores/toastStore";
import { importDataJson, isTauri } from "@/lib/tauri";
import { StepShell } from "./StepShell";
import { useOnboardingStore } from "@/stores/onboardingStore";

/**
 * First screen — Loach mark, app name, one-line value prop, primary
 * "Get started" button, and a quiet "Restore from backup" affordance
 * underneath for users coming from another install or post-factory-reset.
 *
 * Restore replaces the SQLite contents wholesale, so we hard-reload after
 * import to let every store re-hydrate against the fresh DB. The reload
 * also short-circuits onboarding for the new contents — `onboarding_completed`
 * arrives true from the import, so the wizard won't fire again.
 */

export function WelcomeStep({ onClose }: { onClose: () => void }) {
  const goNext = useOnboardingStore((s) => s.goNext);
  const push = useToastStore((s) => s.push);
  const [busy, setBusy] = useState(false);

  const handleRestore = async () => {
    if (!isTauri) {
      push({ kind: "error", title: "Restore requires the desktop app." });
      return;
    }
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Loach export", extensions: ["json"] }],
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) {
        setBusy(false);
        return;
      }
      await importDataJson(path);
      // Full reload — every store re-hydrates against the freshly written
      // DB, including `onboarding_completed` from the import payload.
      window.setTimeout(() => window.location.reload(), 350);
    } catch (e) {
      push({
        kind: "error",
        title: e instanceof Error ? e.message : String(e),
      });
      setBusy(false);
    }
  };

  return (
    <StepShell
      step="welcome"
      title=""
      hideHeader
      centerY
      primaryLabel={null}
      onClose={onClose}
    >
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-foreground/[0.04] shadow-[0_0_40px_rgba(255,120,60,0.18)]">
          <Logo size={48} />
        </div>
        <h1 className="text-5xl font-semibold tracking-tight">
          Welcome to Loach
        </h1>
        <p className="mt-3 max-w-sm text-[13.5px] leading-relaxed text-foreground/60">
          A private, local first AI workspace.
        </p>

        <div className="mt-9 flex flex-col items-stretch gap-2.5">
          <Button onClick={goNext} className="gap-2 px-6 py-5 text-[14px]">
            <Sparkles className="h-4 w-4" />
            Get started
          </Button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] text-foreground/55 transition-colors hover:text-foreground disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {busy ? "Restoring…" : "Restore from backup"}
          </button>
        </div>
      </div>
    </StepShell>
  );
}
