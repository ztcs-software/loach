import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleAlert,
  KeyRound,
  Lock,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useSecurityStore } from "@/stores/securityStore";
import { cn } from "@/lib/utils";
import type { LockMethod } from "@/lib/tauri";

type PinLength = 4 | 6 | 8;
type Mode = "idle" | "setup";

/**
 * Security tab body. Two layouts:
 *
 *   - **Idle / not configured**: short summary card + "Set up app lock" CTA.
 *   - **Setup**: a small wizard (method → credentials → optional hint →
 *     confirm) embedded inline. We don't open a separate dialog because
 *     Settings already lives in one — nesting modals reads as a bug.
 *
 * When a lock IS configured, the idle view gains a "Change" + "Remove"
 * action pair. Change just re-enters the setup flow with the current method
 * pre-selected; Remove asks for confirmation and wipes the keyring blob.
 */
export function SecurityPanel() {
  const status = useSecurityStore((s) => s.status);
  const hydrated = useSecurityStore((s) => s.hydrated);
  const hydrate = useSecurityStore((s) => s.hydrate);
  const setupAction = useSecurityStore((s) => s.setup);
  const clearAction = useSecurityStore((s) => s.clear);

  const [mode, setMode] = useState<Mode>("idle");

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const handleRemove = async () => {
    if (
      !confirm(
        "Remove app lock? Anyone with access to this machine will be able to open Loach without authentication.",
      )
    )
      return;
    await clearAction();
    setMode("idle");
  };

  if (mode === "setup") {
    return (
      <SetupWizard
        initialMethod={status.method ?? "pin"}
        initialPinLength={(status.pin_length as PinLength) ?? 4}
        existingHint={status.has_hint}
        onCancel={() => setMode("idle")}
        onSubmit={async (args) => {
          await setupAction(args);
          setMode("idle");
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-[13px] text-foreground/55">
        Lock the access to Loach with a PIN, a password, or both. Credentials
        are securely stored in your operating system's credentials manager.
      </p>

      {status.configured ? (
        <ConfiguredCard
          method={status.method!}
          pinLength={status.pin_length}
          hasHint={status.has_hint}
          onChange={() => setMode("setup")}
          onRemove={handleRemove}
        />
      ) : (
        <UnconfiguredCard onSetup={() => setMode("setup")} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idle state — summary cards
// ---------------------------------------------------------------------------

function UnconfiguredCard({ onSetup }: { onSetup: () => void }) {
  return (
    <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.025] p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06]">
          <Lock className="h-5 w-5 text-foreground/55" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground/90">
            App lock is off
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/60">
            Anyone with access to this device can open Loach and read your
            chats. Set up a PIN or password to require authentication on
            launch.
          </p>
          <Button onClick={onSetup} className="mt-4 gap-1.5 rounded-lg">
            <KeyRound className="h-4 w-4" />
            Set up app lock
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfiguredCard({
  method,
  pinLength,
  hasHint,
  onChange,
  onRemove,
}: {
  method: LockMethod;
  pinLength: number | null;
  hasHint: boolean;
  onChange: () => void;
  onRemove: () => void;
}) {
  const summary = useMemo(() => {
    switch (method) {
      case "pin":
        return `${pinLength}-digit PIN`;
      case "password":
        return "Password";
      case "both":
        return `${pinLength}-digit PIN + password`;
    }
  }, [method, pinLength]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15">
            <ShieldCheck className="h-5 w-5 text-emerald-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground/90">
              App lock is on
            </h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/65">
              Required at launch:{" "}
              <span className="font-medium text-foreground/85">{summary}</span>
              {hasHint && " · hint configured"}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                onClick={onChange}
                variant="outline"
                className="gap-1.5 rounded-lg"
              >
                <KeyRound className="h-4 w-4" />
                Change
              </Button>
              <Button
                onClick={onRemove}
                variant="outline"
                className="gap-1.5 rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Remove app lock
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup wizard — single-screen form. We deliberately don't paginate it; the
// total field count is small and seeing the whole shape at once helps users
// decide what they're actually committing to.
// ---------------------------------------------------------------------------

function SetupWizard({
  initialMethod,
  initialPinLength,
  existingHint: _existingHint,
  onCancel,
  onSubmit,
}: {
  initialMethod: LockMethod;
  initialPinLength: PinLength;
  existingHint: boolean;
  onCancel: () => void;
  onSubmit: (args: {
    method: LockMethod;
    pin?: string;
    password?: string;
    pin_length?: PinLength;
    hint?: string;
  }) => Promise<void>;
}) {
  const [method, setMethod] = useState<LockMethod>(initialMethod);
  const [pinLength, setPinLength] = useState<PinLength>(initialPinLength);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usesPin = method === "pin" || method === "both";
  const usesPassword = method === "password" || method === "both";

  // Reset PIN inputs when length changes — otherwise "1234" lingering from a
  // 4-digit choice would show up under a 6-digit selection.
  useEffect(() => {
    setPin("");
    setPinConfirm("");
  }, [pinLength, method]);

  const validate = (): string | null => {
    if (usesPin) {
      if (pin.length !== pinLength) return `PIN must be ${pinLength} digits.`;
      if (!/^\d+$/.test(pin)) return "PIN must contain digits only.";
      if (pin !== pinConfirm) return "PIN and confirmation do not match.";
    }
    if (usesPassword) {
      if (password.length < 6)
        return "Password must be at least 6 characters.";
      if (password !== passwordConfirm)
        return "Password and confirmation do not match.";
    }
    return null;
  };

  const handleSubmit = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        method,
        pin: usesPin ? pin : undefined,
        password: usesPassword ? password : undefined,
        pin_length: usesPin ? pinLength : undefined,
        hint: hint.trim() ? hint.trim() : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.025] p-5 space-y-5">
        {/* Method picker */}
        <div>
          <Label>Lock method</Label>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <MethodTile
              title="PIN"
              hint="Quick — digits only"
              selected={method === "pin"}
              onClick={() => setMethod("pin")}
            />
            <MethodTile
              title="Password"
              hint="Standard"
              selected={method === "password"}
              onClick={() => setMethod("password")}
            />
            <MethodTile
              title="PIN + password"
              hint="Two factors"
              selected={method === "both"}
              onClick={() => setMethod("both")}
            />
          </div>
        </div>

        {usesPin && (
          <>
            <Separator />
            <div>
              <Label>PIN length</Label>
              <div className="mt-2 flex gap-2">
                {([4, 6, 8] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPinLength(n)}
                    className={cn(
                      "h-9 w-14 rounded-lg border text-sm font-medium transition-colors",
                      pinLength === n
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-foreground/10 bg-foreground/[0.03] text-foreground/65 hover:bg-foreground/[0.07]",
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>New PIN</Label>
                <Input
                  className="mt-1.5"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={pinLength}
                  value={pin}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/\D/g, "").slice(0, pinLength))
                  }
                  placeholder={"•".repeat(pinLength)}
                />
              </div>
              <div>
                <Label>Confirm PIN</Label>
                <Input
                  className="mt-1.5"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={pinLength}
                  value={pinConfirm}
                  onChange={(e) =>
                    setPinConfirm(
                      e.target.value.replace(/\D/g, "").slice(0, pinLength),
                    )
                  }
                  placeholder={"•".repeat(pinLength)}
                />
              </div>
            </div>
          </>
        )}

        {usesPassword && (
          <>
            <Separator />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>New password</Label>
                <Input
                  className="mt-1.5"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                />
              </div>
              <div>
                <Label>Confirm password</Label>
                <Input
                  className="mt-1.5"
                  type="password"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  placeholder="Repeat password"
                />
              </div>
            </div>
          </>
        )}

        <Separator />

        <div>
          <Label>
            Hint <span className="text-foreground/40">(optional)</span>
          </Label>
          <Input
            className="mt-1.5"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="e.g. street I grew up on"
            maxLength={120}
          />
          <p className="mt-1.5 text-[11px] text-foreground/50">
            Shown on the lock screen via "Show hint". Don't put the actual
            secret in here.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11.5px] text-foreground/45">
          Lost credentials cannot be recovered — only the hint can help.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={busy}
            className="gap-1.5"
          >
            <Check className="h-4 w-4" />
            {busy ? "Saving…" : "Enable lock"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MethodTile({
  title,
  hint,
  selected,
  onClick,
}: {
  title: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-primary/60 bg-primary/10"
          : "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.07]",
      )}
    >
      <span
        className={cn(
          "text-[13px] font-semibold",
          selected ? "text-foreground" : "text-foreground/85",
        )}
      >
        {title}
      </span>
      <span className="text-[11px] text-foreground/50">{hint}</span>
    </button>
  );
}
