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
import { useEffect, useRef } from "react";
import { useIsDesktop } from "../lib/useMediaQuery";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title shown in the sheet/modal header. */
  title?: string;
  /** Sheet body. Caller controls form layout/padding. */
  children: React.ReactNode;
  /** Width cap when rendered as a desktop modal. Default = md. */
  desktopMaxWidth?: "sm" | "md" | "lg";
  /** Take the entire viewport — no rounded top, no drag handle, no
   *  backdrop. Used by Settings so it reads as a full page rather
   *  than a card peeking up from the bottom. */
  fullPage?: boolean;
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  desktopMaxWidth = "md",
  fullPage = false,
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
        className="fixed inset-0 z-50 flex flex-col bg-paper outline-none dark:bg-neutral-900"
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
          className={`relative z-10 w-full ${widthClass} overflow-hidden rounded-2xl border border-neutral-200 bg-paper shadow-2xl outline-none dark:border-neutral-800 dark:bg-neutral-900`}
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
        className="animate-bible-sheet-up relative z-10 max-h-[92vh] w-full overflow-hidden rounded-t-2xl border-t border-neutral-200 bg-paper shadow-2xl outline-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        {/* Drag handle (visual). Tap to close as a fallback. */}
        <button
          onClick={onClose}
          aria-label="Close"
          className="grid w-full place-items-center py-2"
        >
          <span className="h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </button>
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
          className="overflow-y-auto"
          style={{ maxHeight: "calc(92vh - 60px)" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
