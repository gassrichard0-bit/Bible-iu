/**
 * Account-recovery modal — opened from the "Forgot password?" link on
 * the Login page. Two modes:
 *
 *   • "backup"  — handle + a 12-char backup code + new password (the
 *                 original flow; codes are minted at signup, single-use).
 *   • "email"   — type the email on file; we send a reset link valid
 *                 for 30 minutes. The link lands the PWA on
 *                 ResetPasswordSheet (see App.tsx ?reset=<token> handler).
 *
 * The two paths complement each other: a user who lost their codes can
 * still recover via email, and a user without an email can recover via
 * code. Either succeeds, the server invalidates every existing session
 * and the user signs in fresh.
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

type Mode = "backup" | "email";

export function RecoverModal({ open, onClose, onRecovered }: Props) {
  const [mode, setMode] = useState<Mode>("backup");
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setMode("backup");
      setHandle("");
      setCode("");
      setNewPassword("");
      setEmail("");
      setEmailSent(false);
      setError(null);
      setBusy(false);
      setTimeout(() => handleRef.current?.focus(), 30);
    }
  }, [open]);

  // Re-focus when the user switches modes.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTimeout(() => {
      if (mode === "backup") handleRef.current?.focus();
      else emailRef.current?.focus();
    }, 30);
  }, [mode, open]);

  if (!open) return null;

  async function submitBackup() {
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

  async function submitEmail() {
    if (busy) return;
    const e = email.trim().toLowerCase();
    if (!e || !e.includes("@") || e.length < 3) {
      setError("Enter the email on file for your account");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.authForgotPassword(e);
      // Backend always returns 200 to prevent enumeration. Show the
      // generic "check your email" success regardless — if the
      // address isn't registered, the user will just never get a
      // link, which is the same outcome from their perspective.
      setEmailSent(true);
    } catch (err) {
      setError(`Error: ${(err as Error).message}`);
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
      <div className="px-4 pb-3 pt-1">
        <div
          role="tablist"
          className="mb-3 inline-flex rounded-full border border-neutral-200 bg-paper p-0.5 text-[12px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] dark:border-neutral-700 dark:bg-neutral-900"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "backup"}
            onClick={() => setMode("backup")}
            className={`rounded-full px-3 py-1 transition ${
              mode === "backup"
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Backup code
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "email"}
            onClick={() => setMode("email")}
            className={`rounded-full px-3 py-1 transition ${
              mode === "email"
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Email link
          </button>
        </div>

        {mode === "backup" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitBackup();
            }}
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
                onChange={(e) => setCode(e.target.value.toUpperCase())}
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
        ) : emailSent ? (
          <div>
            <p className="mb-3 text-[13px] text-neutral-700 dark:text-neutral-200">
              If that email is on file, we've sent a reset link.
              <br />
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                The link expires in 30 minutes. Check your spam folder
                if it doesn't show up.
              </span>
            </p>
            <div className="flex items-center justify-end">
              <ActionButton type="button" onClick={onClose}>
                OK
              </ActionButton>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitEmail();
            }}
          >
            <p className="mb-3 text-[11px] text-neutral-500 dark:text-neutral-400">
              Type the email you added to your profile. We'll send a
              one-time link to reset your password — it expires in 30
              minutes.
            </p>
            <label className="mb-3 block">
              <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
                Email
              </span>
              <input
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
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
                {busy ? "Sending…" : "Send reset link"}
              </ActionButton>
            </div>
          </form>
        )}
      </div>
    </BottomSheet>
  );
}
