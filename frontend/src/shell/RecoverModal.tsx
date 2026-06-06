/**
 * Account-recovery modal — opened from the "Forgot password?" link on
 * the Login page. Asks for handle + one backup code + a new password.
 *
 * On success: server burns the code, resets the password, kills all
 * other sessions, and issues a fresh session token. We persist that
 * token and bounce straight into the app (same callback as Login).
 */
import { useEffect, useRef, useState } from "react";
import { api, setSessionToken, type SessionResponse } from "../lib/api";
import { BottomSheet } from "./BottomSheet";
import { ActionButton, Pill } from "./SettingsButtons";

interface Props {
  open: boolean;
  onClose: () => void;
  onRecovered: (s: SessionResponse) => void;
}

export function RecoverModal({ open, onClose, onRecovered }: Props) {
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setHandle("");
      setCode("");
      setNewPassword("");
      setError(null);
      setBusy(false);
      setTimeout(() => handleRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    if (handle.trim().length < 2) {
      setError("Enter your handle");
      return;
    }
    if (code.replace(/\s|-/g, "").length < 12) {
      setError("Backup code looks too short");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be 8+ characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sess = await api.authRecover(
        handle.trim(),
        code.trim(),
        newPassword,
      );
      setSessionToken(sess.token);
      onRecovered(sess);
      onClose();
    } catch (e) {
      const m = (e as Error).message;
      setError(
        m.startsWith("401")
          ? "Handle or backup code is wrong."
          : m.startsWith("400")
            ? "Check the fields — backup codes are 12 chars, password 8+."
            : `Error: ${m}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Recover your account"
      desktopMaxWidth="sm"
    >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="px-4 py-3"
        >
          <p className="mb-3 text-[11px] text-neutral-500 dark:text-neutral-400">
            Use one of the backup codes you saved when you set up your
            account. The code is single-use.
          </p>
          <label className="mb-2 block">
            <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
              Handle
            </span>
            <input
              ref={handleRef}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              autoComplete="username"
              className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
            />
          </label>
          <label className="mb-2 block">
            <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
              Backup code
            </span>
            <input
              value={code}
              onChange={(e) =>
                setCode(e.target.value.toUpperCase())
              }
              placeholder="XXXX-XXXX-XXXX"
              className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 font-mono text-[15px] tracking-wider outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
            />
          </label>
          <label className="mb-3 block">
            <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
              New password (8+ chars)
            </span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
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
              {busy ? "Recovering…" : "Reset password"}
            </ActionButton>
          </div>
        </form>
    </BottomSheet>
  );
}
