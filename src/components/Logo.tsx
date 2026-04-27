import logoBlack from "@/assets/loach-logo-black.svg";
import logoOrange from "@/assets/loach-logo-orange.svg";
import { cn } from "@/lib/utils";

/**
 * Theme-aware Loach mark.
 *
 * Renders both PNG-equivalent SVG assets — black for light mode, orange
 * (#f96610) for dark mode — and lets Tailwind's `dark:` modifier toggle
 * which one is visible. The CSS-driven swap avoids a JS re-render on theme
 * change and keeps the brand crisp at any size (vector all the way down).
 *
 * Sized via the `size` prop in pixels; default 16 mirrors the previous
 * gradient-dot mark in the title bar. Pass `aria-hidden` when the logo
 * sits next to a textual brand label that already names the app.
 */
export function Logo({
  size = 16,
  className,
  ariaHidden = false,
}: {
  size?: number;
  className?: string;
  ariaHidden?: boolean;
}) {
  const dim = { width: size, height: size };
  const alt = ariaHidden ? "" : "Loach";
  return (
    <>
      <img
        src={logoBlack}
        alt={alt}
        aria-hidden={ariaHidden || undefined}
        {...dim}
        className={cn("inline-block dark:hidden", className)}
        draggable={false}
      />
      <img
        src={logoOrange}
        alt={alt}
        aria-hidden={ariaHidden || undefined}
        {...dim}
        className={cn("hidden dark:inline-block", className)}
        draggable={false}
      />
    </>
  );
}
