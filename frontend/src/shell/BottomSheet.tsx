/**
 * Bottom sheet primitive.
 *
 * Slides up from the bottom on mobile (below md). On desktop, falls
 * back to a centered modal — same API, different shell. Lets the
 * existing modal contents (Settings sections, New-room form, etc.)
 * stay agnostic.
 *
 * The sheet caps at 92vh with internal scroll. A drag handle (visual
 * only — gesture lib is out of scope for now) hints at swipe-down.
 * Escape closes; backdrop tap closes.
 */
import { useEffect, useRef, useState } from "react";
import { useIsDesktop } from "../lib/useMediaQuery";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title shown in the sheet/modal header. */
  title?: string;
  /** Sheet body. Caller controls form layout/padding. */
  children: React.ReactNode;
  /** Width cap when rendered as a desktop modal. Default = md. */
  desktopMaxWidth?: "sm" | "md" | "lg" | "xl" | "2xl";
  /** Take the entire viewport — no rounded top, no drag handle, no
   *  backdrop. Used by Settings so it reads as a full page rather
   *  than a card peeking up from the bottom. */
  fullPage?: boolean;
  /** Fractions of the viewport height the sheet can snap to. Sorted
   *  ascending. E.g. `[0.5, 0.92]` = half, then near-full. When set,
   *  the mobile sheet renders with a controlled height (not a passive
   *  max-h), the drag handle resizes the sheet between snap points,
   *  and dragging below the smallest snap point past a threshold
   *  dismisses. When undefined, the sheet behaves classically — opens
   *  at content height capped by `max-h-[92dvh]`. */
  snapPoints?: number[];
  /** Index into `snapPoints` to use on first open. Default = 0 (the
   *  smallest, so the sheet enters at the lowest preset height and
   *  the user can drag up if they want more). Ignored when
   *  `snapPoints` is undefined. */
  initialSnap?: number;
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  desktopMaxWidth = "md",
  fullPage = false,
  snapPoints,
  initialSnap = 0,
}: Props) {
  const isDesktop = useIsDesktop();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Remember who had focus when the sheet opened so we can restore
  // it on close — required by the WAI-ARIA modal pattern.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Global Escape — works regardless of focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open so the sheet doesn't trap behind it.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus management — capture the previously-focused element on
  // open, restore it on close. The dialog itself is focused so the
  // very next Tab lands inside it instead of escaping into the
  // background, which is the entire point of "modal".
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      (document.activeElement as HTMLElement) || null;
    // Wait a tick so the dialog has mounted.
    const id = window.setTimeout(() => {
      dialogRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      // Only restore if the focus is still inside the (about-to-
      // unmount) dialog; otherwise the user moved on intentionally.
      const active = document.activeElement as HTMLElement | null;
      if (
        returnFocusRef.current &&
        (!active || dialogRef.current?.contains(active))
      ) {
        try {
          returnFocusRef.current.focus();
        } catch {
          // The previously focused element may have unmounted.
        }
      }
      returnFocusRef.current = null;
    };
  }, [open]);

  // Tab-key focus trap. Cycles Tab / Shift+Tab through the
  // focusable descendants of the dialog so focus can't escape into
  // the page underneath while the modal is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // --- Snap-point drag state ------------------------------------------
  // Only relevant when `snapPoints` is provided. Tracks the sheet's
  // current visible height as a fraction of the viewport. While the
  // user is dragging the handle, this updates live; on release we
  // snap to the nearest snap point (or dismiss if dragged too low).
  const sortedSnaps = snapPoints
    ? [...snapPoints].sort((a, b) => a - b)
    : null;
  const clampedInitial = sortedSnaps
    ? Math.min(Math.max(0, initialSnap), sortedSnaps.length - 1)
    : 0;
  const [heightFraction, setHeightFraction] = useState<number>(
    sortedSnaps ? sortedSnaps[clampedInitial] : 0,
  );
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    y: number;
    startFraction: number;
    viewportH: number;
  } | null>(null);

  // Reset to the initial snap whenever the sheet re-opens (so a sheet
  // the user dragged to 92% then closed comes back at 50% next time).
  useEffect(() => {
    if (!open || !sortedSnaps) return;
    setHeightFraction(sortedSnaps[clampedInitial]);
  }, [open, clampedInitial, sortedSnaps?.[clampedInitial]]); // eslint-disable-line react-hooks/exhaustive-deps

  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!sortedSnaps) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragStartRef.current = {
      y: e.clientY,
      startFraction: heightFraction,
      viewportH: window.visualViewport?.height ?? window.innerHeight,
    };
    setIsDragging(true);
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // pointer capture best-effort
    }
  }
  function onHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    if (!start || !sortedSnaps) return;
    const dy = e.clientY - start.y; // positive = drag DOWN (shrink)
    const deltaFrac = dy / start.viewportH;
    // Below the smallest snap point we allow a little overshoot so the
    // user feels the sheet "stretch" before dismiss; above the largest
    // snap point we clamp (no over-expand).
    const min = Math.max(0, sortedSnaps[0] - 0.15);
    const max = sortedSnaps[sortedSnaps.length - 1];
    const next = Math.max(min, Math.min(max, start.startFraction - deltaFrac));
    setHeightFraction(next);
  }
  function onHandlePointerUp() {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    setIsDragging(false);
    if (!start || !sortedSnaps) return;
    // Dismiss when dragged ~10% below the smallest snap point.
    if (heightFraction < sortedSnaps[0] - 0.08) {
      onClose();
      return;
    }
    // Snap to the nearest defined snap point.
    let nearest = sortedSnaps[0];
    let bestDist = Math.abs(heightFraction - nearest);
    for (const sp of sortedSnaps) {
      const d = Math.abs(heightFraction - sp);
      if (d < bestDist) {
        bestDist = d;
        nearest = sp;
      }
    }
    setHeightFraction(nearest);
  }

  if (!open) return null;

  // Full-page mode — single layout used on both mobile and desktop.
  // Takes the whole viewport, no backdrop, no rounded corners, no
  // drag handle. Reads as a screen, not a sheet.
  if (fullPage) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="glass-specular fixed inset-0 z-50 flex flex-col bg-paper/85 outline-none backdrop-blur-[40px] backdrop-saturate-[1.8] dark:bg-neutral-900/70"
      >
        {title && (
          <header
            className="flex items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800"
            style={{
              paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.625rem)",
              paddingBottom: "0.625rem",
            }}
          >
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
              aria-label="Close"
            >
              ✕
            </button>
          </header>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    );
  }

  if (isDesktop) {
    const widthClass =
      desktopMaxWidth === "sm"
        ? "max-w-sm"
        : desktopMaxWidth === "lg"
          ? "max-w-lg"
          : desktopMaxWidth === "xl"
            ? "max-w-2xl"
            : desktopMaxWidth === "2xl"
              ? "max-w-4xl"
              : "max-w-md";
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute inset-0 bg-black/40"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          className={`glass-specular relative z-10 w-full ${widthClass} overflow-hidden rounded-2xl border border-white/40 bg-paper/70 shadow-[0_24px_64px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.55)] outline-none backdrop-blur-[40px] backdrop-saturate-[1.8] dark:border-white/15 dark:bg-neutral-900/55 dark:shadow-[0_24px_64px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.10)]`}
        >
          {title && (
            <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
              <h2 className="text-sm font-semibold">{title}</h2>
              <button
                onClick={onClose}
                className="rounded p-1 text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
                aria-label="Close"
              >
                ✕
              </button>
            </header>
          )}
          <div className="max-h-[80vh] overflow-y-auto">{children}</div>
        </div>
      </div>
    );
  }

  // Mobile: bottom sheet.
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // `dvh` instead of `vh` so the sheet caps at the VISIBLE
        // viewport height. iOS Safari's `vh` refers to the layout
        // viewport (URL bar collapsed), so with the address bar
        // showing, 92vh would push the sheet's bottom edge off
        // screen — taking the last rows of a long contacts list /
        // settings list with it and breaking scroll-to-bottom.
        //
        // With `snapPoints`: explicit controlled HEIGHT (as % of dvh)
        // so the user's drag can resize the sheet between presets.
        // Without snapPoints: legacy max-h behavior so existing
        // modals (Settings, Contacts, etc.) are unchanged.
        className="glass-specular animate-bible-sheet-up relative z-10 w-full overflow-hidden rounded-t-[28px] border-t border-white/40 bg-paper/70 shadow-[0_-12px_48px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.55)] outline-none backdrop-blur-[40px] backdrop-saturate-[1.8] dark:border-white/15 dark:bg-neutral-900/55 dark:shadow-[0_-12px_48px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.10)]"
        style={
          sortedSnaps
            ? {
                height: `${heightFraction * 100}dvh`,
                maxHeight: "100dvh",
                transition: isDragging
                  ? "none"
                  : "height 240ms cubic-bezier(0.32, 0.72, 0.0, 1)",
              }
            : { maxHeight: "92dvh" }
        }
      >
        {/* Drag handle. Without snapPoints: visual only, tap to close.
         *  With snapPoints: pointer drag resizes the sheet live, snaps
         *  to the nearest preset on release, dismisses when dragged
         *  below the smallest preset by ~10% of viewport. */}
        {sortedSnaps ? (
          <div
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
            role="button"
            aria-label="Drag to resize; release to snap"
            className="grid w-full cursor-grab touch-none place-items-center py-3 active:cursor-grabbing"
            style={{ touchAction: "none" }}
          >
            <span className="h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          </div>
        ) : (
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid w-full place-items-center py-2"
          >
            <span className="h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          </button>
        )}
        {title && (
          <header className="flex items-center justify-between border-b border-neutral-200 px-4 pb-2 dark:border-neutral-800">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
              aria-label="Close"
            >
              ✕
            </button>
          </header>
        )}
        <div
          className="overflow-y-auto overscroll-contain"
          // Inner scroll area: cap relative to the OUTER sheet's
          // current height. With snapPoints the parent is sized in
          // dvh; without snapPoints the parent is capped at 92dvh.
          // Either way, subtracting ~60px (the handle + title row)
          // gives the scroll-area its working height.
          style={{
            maxHeight: sortedSnaps
              ? `calc(${heightFraction * 100}dvh - 60px)`
              : "calc(92dvh - 60px)",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
