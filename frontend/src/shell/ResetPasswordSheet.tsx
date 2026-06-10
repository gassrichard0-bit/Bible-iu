/**
 * Lands when the PWA loads with `?reset=<token>` — the email link that
 * `RecoverModal` (email mode) caused the backend to send. Asks for a
 * new password, POSTs `/auth/reset-password`, then nudges the user to
 * sign in fresh.
 *
 * The token is whatever's in the URL — opaque to us. The backend
 * compares its SHA-256 against the row in `password_reset_tokens`,
 * verifies it isn't expired or used, sets the new password, and kills
 * every session belonging to that user.
 */
import { useEffect, useRef, useState } from "react";
import { api, clearSessionToken } from "../lib/api";
import { BottomSheet } from "./BottomSheet";
import { ActionButton, Pill } from "./SettingsButtons";

interface Props {
  token: string;
  onClose: () => void;
  /** Called after a successful reset so the host can drop any cached
   *  session, surface the login screen, etc. */
  onReset: () => void;
}

export function ResetPasswordSheet({ token, onClose, onReset }: Props) {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 30);
  }, []);

  async function submit() {
    if (busy) return;
    if (newPassword.length < 8) {
      setError("New password must be 8+ characters");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.authResetPassword(token, newPassword);
      // Backend has already deleted every session for this user.
      // Drop any cached token locally so the login screen shows up
      // on the next render.
      clearSessionToken();
      setDone(true);
      onReset();
    } catch (e) {
      const m = (e as Error).message;
      setError(
        m.startsWith("400")
          ? "This link expired or has already been used — request a new one from the sign-in page."
          : `Error: ${m}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open
      onClose={onClose}
      title="Set a new password"
      desktopMaxWidth="sm"
    >
      <div className="px-4 pb-3 pt-1">
        {done ? (
          <div>
            <p className="mb-3 text-[13px] text-neutral-700 dark:text-neutral-200">
              Done — your password has been reset. Sign in with the new
              password to continue.
            </p>
            <div className="flex items-center justify-end">
              <ActionButton type="button" onClick={onClose}>
                Sign in
              </ActionButton>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="mb-3 text-[11px] text-neutral-500 dark:text-neutral-400">
              Pick a new password (8+ characters). Every existing
              session will be signed out when you finish.
            </p>
            <label className="mb-2 block">
              <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
                New password
              </span>
              <input
                ref={ref}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
                Confirm new password
              </span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
              />
            </label>
            {error && (
              <p className="mb-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Pill type="button" onClick={onClose}>
                Cancel
              </Pill>
              <ActionButton type="submit" disabled={busy}>
                {busy ? "Resetting…" : "Reset password"}
              </ActionButton>
            </div>
          </form>
        )}
      </div>
    </BottomSheet>
  );
}
