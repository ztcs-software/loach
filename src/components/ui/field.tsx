import * as React from "react";

/**
 * A labelled form field for the create/edit dialogs (snippet, variable,
 * Space, dataset, text). The visible label used to exist only in the
 * variable dialog; the rest relied on placeholders, which vanish as soon as
 * the user types. Wraps the control in a `<label>`, so clicking the label
 * focuses it without an `htmlFor`.
 */
export function Field({
  label,
  optional = false,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium text-foreground/65">
        {label}
        {optional && <span className="font-normal text-foreground/45"> (optional)</span>}
      </span>
      {children}
    </label>
  );
}
