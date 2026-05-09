import logo from "@/assets/loach-logo.png";
import { cn } from "@/lib/utils";

export function Logo({
  size = 16,
  className,
  ariaHidden = false,
}: {
  size?: number;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <img
      src={logo}
      alt={ariaHidden ? "" : "Loach"}
      aria-hidden={ariaHidden || undefined}
      width={size}
      height={size}
      className={cn("inline-block", className)}
      draggable={false}
    />
  );
}
