import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        // Focus was signalled only by the border going from foreground/10 to
        // /25 — a 1.4:1 change against the field, which is not a visible
        // indicator by any measure and left text fields as the one control
        // family without the ring every other primitive uses (Button,
        // Slider, the onboarding cards). Ring added; the border/background
        // shift stays as the secondary cue.
        "flex h-10 w-full rounded-2xl border border-foreground/10 bg-foreground/[0.05] px-4 py-1 text-sm text-foreground backdrop-blur-xl transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-foreground/35 focus-visible:border-foreground/25 focus-visible:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
