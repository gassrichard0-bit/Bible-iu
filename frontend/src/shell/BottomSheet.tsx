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
import { useEffect } from "react";
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
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  desktopMaxWidth = "md",
}: Props) {
  const isDesktop = useIsDesktop();

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

  if (!open) return null;

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
          role="dialog"
          aria-modal="true"
          className={`relative z-10 w-full ${widthClass} overflow-hidden rounded-lg border border-neutral-200 bg-paper shadow-xl dark:border-neutral-800 dark:bg-neutral-900`}
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
        role="dialog"
        aria-modal="true"
        className="animate-bible-sheet-up relative z-10 max-h-[92vh] w-full overflow-hidden rounded-t-2xl border-t border-neutral-200 bg-paper shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
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
