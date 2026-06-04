import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Returns `true` whenever the query
 * currently matches. Used to branch between desktop and mobile layouts
 * for things that can't be done with CSS alone (e.g. conditional
 * react-resizable-panels rendering).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** Desktop breakpoint = Tailwind `md` (>=768px). */
export const useIsDesktop = () => useMediaQuery("(min-width: 768px)");
