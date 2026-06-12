/**
 * Liquid-glass confirm dialog for destructive actions (notes/messages
 * delete). Uses the project's WWDC25-style glass tokens (GLASS_SHEET +
 * specular sweep + interactive press) so it matches the rest of the
 * Liquid Glass surfaces in the app.
 *
 * Mount <ConfirmDialogHost /> once near the app root. Call
 * `confirmDelete()` from anywhere — it returns a promise resolving
 * true (confirmed) or false (cancelled).
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  GLASS_SHEET,
  GLASS_SPECULAR,
  GLASS_INTERACTIVE,
} from "./glass";

type Pending = {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  resolve: (ok: boolean) => void;
};

let setPendingExternal: ((p: Pending | null) => void) | null = null;

export function confirmDelete(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setPendingExternal) {
      // Host not mounted yet — fall back to the native confirm so we
      // never silently drop a destructive intent.
      resolve(window.confirm(opts.message || opts.title));
      return;
    }
    setPendingExternal({
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Delete",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      destructive: true,
      resolve,
    });
  });
}

export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  // Entrance animation flag — flips one tick after mount so the modal
  // springs in with a Liquid-Glass-style scale+fade rather than appearing
  // flat.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setPendingExternal = setPending;
    return () => {
      setPendingExternal = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pending.resolve(false);
        setPending(null);
      } else if (e.key === "Enter") {
        pending.resolve(true);
        setPending(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [pending]);

  if (!pending) return null;

  const confirm = () => {
    pending.resolve(true);
    setPending(null);
  };
  const cancel = () => {
    pending.resolve(false);
    setPending(null);
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center px-6"
      style={{
        // iOS-style dim + soft scene blur behind the alert.
        background: shown ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0)",
        backdropFilter: shown ? "blur(8px)" : "blur(0px)",
        WebkitBackdropFilter: shown ? "blur(8px)" : "blur(0px)",
        transition: "background 220ms ease-out, backdrop-filter 220ms ease-out, -webkit-backdrop-filter 220ms ease-out",
      }}
      onClick={cancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-[300px] overflow-hidden ${GLASS_SHEET} ${GLASS_SPECULAR}`}
        style={{
          transform: shown ? "scale(1)" : "scale(0.92)",
          opacity: shown ? 1 : 0,
          transition: "transform 260ms cubic-bezier(0.22, 1.2, 0.36, 1), opacity 200ms ease-out",
        }}
      >
        <div className="px-5 pt-5 pb-4 text-center">
          <div
            id="confirm-dialog-title"
            className="text-[18px] font-semibold leading-tight text-neutral-900 dark:text-neutral-50"
          >
            {pending.title}
          </div>
          {pending.message && (
            <div className="mt-2 text-[13.5px] leading-snug text-neutral-700 dark:text-neutral-300">
              {pending.message}
            </div>
          )}
        </div>
        {/* Hairline separator — picks up the underlying tint just like
            the lensing edge on the rest of the sheet. */}
        <div className="h-px bg-gradient-to-r from-transparent via-white/35 to-transparent dark:via-white/12" />
        <div className="flex h-12">
          <button
            onClick={cancel}
            autoFocus
            className={`flex-1 text-[17px] font-medium text-blue-600 dark:text-blue-300 ${GLASS_INTERACTIVE} hover:bg-white/20 dark:hover:bg-white/5`}
          >
            {pending.cancelLabel}
          </button>
          <div className="w-px bg-gradient-to-b from-transparent via-white/30 to-transparent dark:via-white/10" />
          <button
            onClick={confirm}
            className={`flex-1 text-[17px] font-semibold ${GLASS_INTERACTIVE} hover:bg-white/20 dark:hover:bg-white/5 ${
              pending.destructive
                ? "text-red-600 dark:text-red-300"
                : "text-blue-600 dark:text-blue-300"
            }`}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
