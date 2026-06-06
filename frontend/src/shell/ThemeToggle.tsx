import type { Theme } from "../lib/theme";

interface Props {
  theme: Theme;
  onToggle: () => void;
  /** Compact: icon only on mobile, label on md+. Use in cramped headers. */
  compact?: boolean;
}

export function ThemeToggle({ theme, onToggle, compact }: Props) {
  const isDark = theme === "dark";
  if (compact) {
    return (
      <button
        onClick={onToggle}
        className="inline-flex min-h-[36px] items-center justify-center rounded-full border border-neutral-200 bg-paper px-3 text-[12px] font-semibold text-neutral-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:hover:bg-neutral-800"
        title={`Switch to ${isDark ? "light" : "dark"} mode`}
        aria-label="Toggle theme"
      >
        <span className="hidden md:inline">
          {isDark ? "☼ Light" : "☾ Dark"}
        </span>
        <span className="md:hidden">{isDark ? "☼" : "☾"}</span>
      </button>
    );
  }
  return (
    <button
      onClick={onToggle}
      className="inline-flex min-h-[36px] items-center rounded-full border border-neutral-200 bg-paper px-3 text-[12px] font-semibold text-neutral-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:hover:bg-neutral-800"
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
      aria-label="Toggle theme"
    >
      {isDark ? "☼ Light" : "☾ Dark"}
    </button>
  );
}
