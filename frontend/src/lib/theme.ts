/**
 * Theme controller — toggles the `dark` class on <html>.
 *
 * Default order: explicit user choice (localStorage) → system preference.
 * The Tailwind config uses `darkMode: "class"`, so applying/removing
 * `dark` on <html> flips every `dark:` variant in the tree.
 */
const KEY = "bible-iu:theme";

export type Theme = "light" | "dark";

export function readTheme(): Theme {
  const saved = (typeof localStorage !== "undefined" &&
    localStorage.getItem(KEY)) as Theme | null;
  if (saved === "light" || saved === "dark") return saved;
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  localStorage.setItem(KEY, theme);
}
