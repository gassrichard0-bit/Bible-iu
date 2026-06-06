/**
 * Returns the number of CSS pixels the soft keyboard is currently
 * covering at the bottom of the layout viewport.
 *
 * `position: fixed; bottom: 0` anchors to the *layout* viewport, which
 * on iOS Safari doesn't shrink when the keyboard opens. The composer
 * then sits behind the keyboard with a gap above it. Adding this
 * offset to the composer's `bottom` lifts it onto the keyboard.
 *
 * iOS 17.4+ + Chrome Android handle this natively when the meta
 * viewport includes `interactive-widget=resizes-content` (we set it).
 * This hook covers the older iOS Safari fallback where the meta is
 * ignored — the visualViewport API still reports the correct height.
 */
import { useEffect, useState } from "react";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const compute = () => {
      const layoutH = window.innerHeight;
      const visibleH = vv.height;
      const offsetTop = vv.offsetTop;
      // What's hidden at the bottom = layout height − (visible height + how
      // far down the visible viewport has been scrolled). Clamp to 0 so a
      // small floating-point drift doesn't push the composer up.
      const hidden = Math.max(0, layoutH - (visibleH + offsetTop));
      setInset(hidden);
    };
    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
    };
  }, []);
  return inset;
}
