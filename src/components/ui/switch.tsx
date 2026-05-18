import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/* ───── Switch variant context ─────
 *
 * The Switch primitive needs to know which visual variant ("flat" vs
 * "glassy") to render by default — that decision tracks the app's
 * `background_style` setting. Previously this file pulled the value
 * directly from `useSettingsStore`, which broke the "components/ui is
 * portable, store-agnostic" shadcn convention and made the primitive
 * harder to drop into Storybook / tests / future spaces.
 *
 * Instead we read the variant from a tiny React context. Anyone who
 * wants the theme default wraps their tree in `<SwitchVariantProvider
 * value={…}>` (`App.tsx` does this once); anyone who needs a fixed
 * style can still pass `variant="flat" | "glassy"` directly on the
 * call site. Defaults to "flat" so an unwrapped use still renders
 * sensibly. */
type SwitchVariant = "flat" | "glassy";
const SwitchVariantContext = React.createContext<SwitchVariant>("flat");
export const SwitchVariantProvider = SwitchVariantContext.Provider;

/**
 * Pill-style toggle switch — green track when on, neutral when off, white
 * knob that slides between the two ends. Replaces the previous "filled vs.
 * outline button with a label" pattern that read as a state-disagreeing
 * action (the user couldn't tell whether the button's current colour was
 * the current state or the action it would perform).
 *
 * Two visual variants, picked at the call site to match the app theme:
 *
 *   - **flat** (default): solid track, plain white knob. The right pick
 *     for the Solid background — the chrome around it is also flat, so a
 *     glassy switch would feel out of place.
 *   - **glassy**: translucent track + a white knob with a soft shadow and
 *     a faint inner highlight. Matches the gradient-mesh + glass surfaces
 *     of the Aurora background.
 *
 * Both variants use `--primary` for the on-state colour, so they pick up
 * the azure-light / orange-dark accent swap automatically.
 *
 * Built on `@radix-ui/react-switch` so keyboard interaction (Space toggles,
 * focus ring), `role="switch"`, `aria-checked`, and form integration are
 * all handled for free.
 */
export interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  /** Explicit visual style. When omitted, the variant comes from the
   *  nearest `SwitchVariantProvider` (App.tsx wires this to the
   *  `background_style` setting) so most call sites stay tidy. */
  variant?: SwitchVariant;
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, variant, ...props }, ref) => {
  // Pull the theme-derived default from context rather than the settings
  // store, so this primitive stays portable. Callers can still override
  // with `variant="flat"` / `"glassy"` per-instance.
  const contextVariant = React.useContext(SwitchVariantContext);
  const resolved = variant ?? contextVariant;
  return (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      // Track sizing + base layout — same across variants so toggling
      // the variant doesn't change the footprint.
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // Off-state border — kept subtle in both variants.
      "border-transparent",
      // On-state fill uses --primary so it tracks the theme accent.
      "data-[state=checked]:bg-primary",
      // Variant-specific off-state surface.
      resolved === "flat"
        ? "data-[state=unchecked]:bg-foreground/15"
        : // Glassy off-state: soft tinted glass with a hairline border so it
          // reads as a surface rather than a flat bar.
          "data-[state=unchecked]:bg-foreground/[0.08] data-[state=unchecked]:border-foreground/15 data-[state=unchecked]:backdrop-blur-md data-[state=unchecked]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.10)]",
      // Glassy ON-state gets a subtle inner highlight too so the knob
      // looks like it's resting on glass, not a printed slab.
      resolved === "glassy" &&
        "data-[state=checked]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-white ring-0 transition-transform",
        // Travel distance: track width (44) - thumb width (20) - left/right
        // inset (2 each) = 20px. Tailwind's `translate-x-5` is exactly 20px.
        "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5",
        // Glassy knob gets a soft shadow so it floats above the track.
        resolved === "glassy"
          ? "shadow-[0_1px_2px_0_rgba(0,0,0,0.25),0_2px_6px_-1px_rgba(0,0,0,0.20)]"
          : "shadow-sm",
      )}
    />
  </SwitchPrimitive.Root>
  );
});
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
