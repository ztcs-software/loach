import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

// Wraps `@radix-ui/react-label` so a click on the label text reliably
// focuses the associated control even when callers omit `htmlFor`. The
// Radix primitive handles the focus delegation by walking up from the
// click target and dispatching to the nearest focusable descendant —
// matches what users expect from a native `<label>` and unblocks
// keyboard / screen-reader users who'd otherwise have to tab to the
// input directly.
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
