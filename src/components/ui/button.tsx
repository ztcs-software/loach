import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-br from-orange-500 to-rose-600 text-white shadow-[0_4px_18px_-4px_rgba(255,90,40,0.6)] hover:from-orange-400 hover:to-rose-500",
        destructive:
          "bg-rose-600/90 text-white shadow-sm hover:bg-rose-500",
        outline:
          "border border-foreground/12 bg-foreground/[0.05] text-foreground/85 backdrop-blur-xl hover:bg-foreground/[0.10] hover:text-foreground",
        secondary:
          "bg-foreground/[0.08] text-foreground/85 hover:bg-foreground/[0.12]",
        ghost: "text-foreground/75 hover:bg-foreground/10 hover:text-foreground",
        link: "text-orange-300 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-11 rounded-2xl px-8",
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
