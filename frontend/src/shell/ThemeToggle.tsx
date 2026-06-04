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
        className="flex h-8 items-center justify-center rounded border border-neutral-200 bg-paper px-2 text-xs text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
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
      className="rounded border border-neutral-200 bg-paper px-2 py-1 text-xs text-neutral-600 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
      aria-label="Toggle theme"
    >
      {isDark ? "☼ Light" : "☾ Dark"}
    </button>
  );
}
