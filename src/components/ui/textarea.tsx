import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-2xl border border-foreground/10 bg-foreground/[0.05] px-4 py-2.5 text-sm text-foreground backdrop-blur-xl placeholder:text-foreground/35 focus-visible:border-foreground/25 focus-visible:bg-foreground/[0.07] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 resize-none",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
