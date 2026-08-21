import { useEffect, useRef, useState } from "react";
import { Eye, KeyRound, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSecurityStore } from "@/stores/securityStore";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";

/**
 * Full-window unlock surface, mounted whenever a lock is configured and the
 * user hasn't authenticated this session yet. Renders above everything else
 * so the chat UI never paints before unlock — no peek-through, no titlebar
 * search affordance. Window controls (min / max / close-to-tray) still work
 * because TitleBar mounts above this in App.tsx.
 *
 * Behaviour:
 *
 *   - PIN-only / Password-only: single field, focused on mount.
 *   - PIN + password: PIN first, then password — order chosen so the
 *     "thing you can type fastest on a numeric pad" is up top.
 *   - On a wrong attempt the inputs clear (PIN empties, password keeps
 *     value so the user can correct a typo) and an error chip flashes.
 *   - "Show hint" reveals the user-supplied hint inline. Hidden until
 *     clicked so a casual passerby doesn't see it.
 */
export function LockScreen() {
  const status = useSecurityStore((s) => s.status);
  const unlock = useSecurityStore((s) => s.unlock);
  const getHint = useSecurityStore((s) => s.getHint);

  const usesPin = status.method === "pin" || status.method === "both";
  const usesPassword =
    status.method === "password" || status.method === "both";
  const pinLength = (status.pin_length as 4 | 6 | 8 | undefined) ?? 4;

  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [showingHint, setShowingHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pinRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Autofocus the first credential field. PIN wins when both are required —
  // it's the field most users will reach for first.
  useEffect(() => {
    if (usesPin) pinRef.current?.focus();
    else if (usesPassword) passwordRef.current?.focus();
  }, [usesPin, usesPassword]);

  const handleSubmit = async () => {
    if (busy) return;
    if (usesPin && pin.length !== pinLength) {
      setError(`PIN must be ${pinLength} digits.`);
      return;
    }
    if (usesPassword && password.length === 0) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await unlock({
        pin: usesPin ? pin : undefined,
        password: usesPassword ? password : undefined,
      });
      if (!ok) {
        setError(
          status.method === "both"
            ? "Either the PIN or the password was wrong."
            : usesPin
              ? "That PIN didn't match."
              : "That password didn't match.",
        );
        // Clear the PIN (cheap to retype) but keep the password (correcting
        // a typo is faster than retyping the whole string).
        setPin("");
        if (usesPin) pinRef.current?.focus();
        else passwordRef.current?.focus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleShowHint = async () => {
    if (showingHint) {
      setShowingHint(false);
      return;
    }
    try {
      const h = await getHint();
      setHint(h ?? "(no hint set)");
    } catch (e) {
      // `securityStore.getHint` passes the keyring error straight through.
      // Unhandled, it reached main.tsx's global net and rendered a generic
      // "Something went wrong" over the lock screen — with no answer to the
      // question the user actually asked.
      logger.warn("hint lookup failed", e);
      setHint("(hint unavailable)");
    }
    setShowingHint(true);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/85 backdrop-blur-xl">
      <div className="w-full max-w-sm px-6">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.06] shadow-[0_0_30px_rgba(255,120,60,0.18)]">
            <Lock className="h-6 w-6 text-foreground/70" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Loach is locked
          </h1>
          <p className="mt-1.5 text-[13px] text-foreground/55">
            {status.method === "both"
              ? "Enter your PIN and password to continue."
              : usesPin
                ? "Enter your PIN to continue."
                : "Enter your password to continue."}
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          className="space-y-4"
        >
          {usesPin && (
            <div>
              <Label htmlFor="lock-pin">PIN</Label>
              <Input
                id="lock-pin"
                ref={pinRef}
                className="mt-1.5 text-center text-lg tracking-[0.5em]"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={pinLength}
                value={pin}
                onChange={(e) => {
                  setError(null);
                  const next = e.target.value
                    .replace(/\D/g, "")
                    .slice(0, pinLength);
                  setPin(next);
                  // Auto-advance to password when PIN is full and a password
                  // is also required. Saves the user a Tab.
                  if (next.length === pinLength && usesPassword) {
                    passwordRef.current?.focus();
                  }
                }}
                placeholder={"•".repeat(pinLength)}
              />
            </div>
          )}

          {usesPassword && (
            <div>
              <Label htmlFor="lock-password">Password</Label>
              <Input
                id="lock-password"
                ref={passwordRef}
                className="mt-1.5"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setError(null);
                  setPassword(e.target.value);
                }}
                placeholder="Your password"
              />
            </div>
          )}

          {error && (
            <div
              className={cn(
                "rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] text-destructive",
              )}
            >
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={busy}
            className="w-full gap-1.5"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {busy ? "Verifying…" : "Unlock"}
          </Button>

          {status.has_hint && (
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleShowHint()}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors"
              >
                <Eye className="h-3.5 w-3.5" />
                {showingHint ? "Hide hint" : "Show hint"}
              </button>
              {showingHint && hint && (
                <p className="max-w-full break-words text-center text-[12.5px] italic text-foreground/65">
                  {hint}
                </p>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
