import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

// Wraps `@radix-ui/react-label` for consistent styling. Note: Radix Label
// only delegates click-to-focus when the control is a *descendant* of the
// Label or the caller sets `htmlFor` to the control's id — it does NOT walk
// the DOM to find a sibling input. Most call sites render the label as a
// sibling, so they get the styling but not click-to-focus; pass `htmlFor`
// (with a matching input `id`) when that behaviour is needed.
const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/55",
      className,
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
