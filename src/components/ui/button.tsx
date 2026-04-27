import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Unified flat-button system. The previous default carried a gradient and a
// drop shadow that read inconsistently against the rest of the (mostly flat)
// chrome — the Spaces tile's "Open" button became the de-facto reference, so
// every variant now matches its visual weight: solid colour, no shadow, no
// gradient, no glass, single shared corner radius (`rounded-lg`).
//
// Primary variants (`default`, `destructive`) still carry colour so the eye
// can pick out the dominant action; secondary / outline / ghost stay neutral.
// `default` reads from the `--primary` CSS variable so it flips with the
// "Solid" theme's azure override automatically.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-foreground/12 bg-transparent text-foreground/85 hover:bg-foreground/[0.06] hover:text-foreground",
        secondary:
          "bg-foreground/[0.08] text-foreground/85 hover:bg-foreground/[0.12]",
        ghost: "text-foreground/75 hover:bg-foreground/10 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
