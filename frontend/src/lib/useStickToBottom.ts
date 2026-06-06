/**
 * Mobile-keyboard-aware "stick to bottom" for a scroll container.
 *
 * iOS Safari and Android Chrome shrink `visualViewport` when the soft
 * keyboard opens. The composer is `position: fixed`, so it rides up
 * with the keyboard — but the message list above keeps its old
 * scrollTop, leaving the newest message hidden under the keyboard.
 *
 * This hook listens to viewport-resize + scroll, tracks whether the
 * list was at-the-bottom right before the keyboard appeared, and
 * re-snaps to bottom on every resize so the latest message stays
 * pinned just above the composer.
 */
import { useEffect, useRef } from "react";

export function useStickToBottom(
  ref: React.RefObject<HTMLElement>,
  /** Add this list to the deps so the hook also re-scrolls when the
   *  list itself changes (e.g. new message arrives). */
  deps: ReadonlyArray<unknown> = [],
) {
  const wasAtBottomRef = useRef(true);

  // Track whether the user is currently at the bottom — anything within
  // ~24px counts. A user who has scrolled up to read history should not
  // be yanked back down by a keyboard event.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const slack = 24;
      wasAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref]);

  // Snap on visualViewport resize + on whatever deps the caller passes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const snap = () => {
      if (wasAtBottomRef.current) {
        // requestAnimationFrame so the layout settles after the
        // keyboard's animation step before we read scrollHeight.
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    };
    snap();
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    vv?.addEventListener("resize", snap);
    vv?.addEventListener("scroll", snap);
    // Some browsers (older iOS Safari) don't fire visualViewport.resize
    // synchronously when the soft keyboard slides up — they fire after
    // an animation. Tagging focusin too means we snap as the user taps
    // the composer, then the resize snap retunes it once the keyboard
    // has finished animating.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) {
        // Wait a tick for the keyboard to start opening, then snap.
        setTimeout(snap, 300);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      vv?.removeEventListener("resize", snap);
      vv?.removeEventListener("scroll", snap);
      document.removeEventListener("focusin", onFocusIn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
}
