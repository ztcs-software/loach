import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

// `role="slider"` lives on the Thumb, not the Root, and Radix does not
// forward the Root's aria-* down to it — so an `aria-label` on <Slider>
// would name a generic span and leave the actual control anonymous. These
// two props exist to land on the Thumb instead:
//   - `thumbLabel`     → the control's name ("Temperature", "Context length")
//   - `thumbValueText` → a human reading of the value. Required for the
//     stops variant, where the raw slider value is an ARRAY INDEX: without
//     it a screen reader announces "3 of 8" instead of "32K".
type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  thumbLabel?: string;
  thumbValueText?: string;
};

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, thumbLabel, thumbValueText, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    {/* Focus ring at `ring-2 ring-ring/40` to match Button + every other
        primitive — the slider was the only one stuck on `ring-1` and the
        skinnier outline made it look like a missing-asset bug next to
        the other focusable elements. */}
    <SliderPrimitive.Thumb
      aria-label={thumbLabel}
      aria-valuetext={thumbValueText}
      className="block h-4 w-4 rounded-full border border-primary/50 bg-primary shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
