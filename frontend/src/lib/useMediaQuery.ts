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

/**
 * Real desktop = wide viewport AND a fine pointer (mouse / trackpad).
 *
 * Width alone was misleading: a modern phone in landscape (iPhone 15
 * Pro Max is 932px wide) cleared the old 768px md breakpoint and
 * flipped the app into desktop mode. Adding `pointer: fine` keeps
 * touch devices (phones + tablets) on the mobile shell regardless of
 * orientation; iPads with a Magic Keyboard / trackpad register as
 * fine and get the desktop layout, which matches user expectation.
 *
 * 1024px is the smallest width where the side-by-side resources +
 * Bible + chat layout has enough breathing room without feeling
 * cramped — anything narrower is better served by the mobile shell.
 */
export const useIsDesktop = () =>
  useMediaQuery("(min-width: 1024px) and (pointer: fine)");
