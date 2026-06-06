/**
 * Shared button system for Settings, Profile, AdminPanel.
 *
 * The Settings sheet used to have ~8 different button treatments
 * (rounded / pill / link / outlined / solid) competing for the user's
 * eye. This collapses them to two:
 *
 *   <ActionButton variant="primary|secondary|destructive">
 *     Large pill — for the main action on a screen ("Save", "Sign out",
 *     "Create group"). Touch target ≥ 44px.
 *
 *   <Pill variant="default|primary|destructive|amber">
 *     Compact inline pill — for in-row toggles, list-row actions
 *     ("Join", "Done", "Theme", "Change photo"). Touch target ≥ 32px.
 *
 * Use `Pill` when the button rides alongside text in a row; use
 * `ActionButton` when it's the dominant action on a panel.
 */
import React from "react";

type Variant = "primary" | "secondary" | "destructive";

const ACTION_VARIANTS: Record<Variant, string> = {
  primary:
    "bg-neutral-900 text-white shadow-sm hover:bg-neutral-800 disabled:bg-neutral-500 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200",
  secondary:
    "border border-neutral-300 bg-paper text-neutral-800 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800",
  destructive:
    "border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40",
};

export function ActionButton({
  variant = "primary",
  fullWidth,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  fullWidth?: boolean;
}) {
  return (
    <button
      {...rest}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-semibold transition disabled:opacity-50 ${
        fullWidth ? "w-full" : ""
      } ${ACTION_VARIANTS[variant]} ${className}`}
    />
  );
}

type PillVariant = "default" | "primary" | "destructive" | "amber";

const PILL_VARIANTS: Record<PillVariant, string> = {
  default:
    "border border-neutral-300 bg-paper text-neutral-700 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800",
  primary:
    "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200",
  destructive:
    "border border-red-300 bg-paper text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-neutral-900 dark:text-red-300 dark:hover:bg-red-950/40",
  amber:
    "border border-amber-300 bg-amber-50/70 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/50",
};

export function Pill({
  variant = "default",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: PillVariant;
}) {
  return (
    <button
      {...rest}
      className={`inline-flex min-h-[32px] items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-50 ${PILL_VARIANTS[variant]} ${className}`}
    />
  );
}
