/**
 * Phone-binding modal — two-step:
 *   1. user enters E.164 phone (with country picker hint)
 *   2. user enters the 6-digit code. WebOTP API auto-fills the input
 *      on Android Chrome / iOS Safari 17.4+ when the SMS arrives.
 *
 * The OTP input declares `autocomplete="one-time-code"` for the iOS
 * Safari keyboard-suggestion path. Programmatic autofill goes through
 * `navigator.credentials.get({ otp: { transport: ["sms"] }, signal })`
 * which is what Chrome on Android uses.
 *
 * Backend is `auth_users.py`'s `/auth/phone/start` and `/auth/phone/verify`.
 * The server returns `dev_code` when no Twilio creds are configured — we
 * pre-fill the OTP field with it so local testing doesn't require
 * tailing the SMS log.
 */
import { useEffect, useRef, useState } from "react";
import { api, type UserProfile } from "../lib/api";
import { BottomSheet } from "./BottomSheet";
import { ActionButton, Pill } from "./SettingsButtons";

interface Props {
  open: boolean;
  onClose: () => void;
  onVerified: (p: UserProfile) => void;
  /** Pre-fill the phone input on retry. Optional. */
  initialPhone?: string;
}

type Step = "phone" | "code";

export function PhoneVerifyModal({
  open,
  onClose,
  onVerified,
  initialPhone,
}: Props) {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState(initialPhone ?? "+1");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // Abort controller for the WebOTP listener — must be torn down on
  // close so a stale listener doesn't fire into an unmounted dialog.
  const otpAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setStep("phone");
      setPhone(initialPhone ?? "+1");
      setCode("");
      setDevCode(null);
      setError(null);
      setBusy(false);
      const t = setTimeout(() => phoneRef.current?.focus(), 30);
      return () => clearTimeout(t);
    } else {
      otpAbortRef.current?.abort();
      otpAbortRef.current = null;
    }
  }, [open, initialPhone]);

  useEffect(() => {
    if (step !== "code") return;
    codeRef.current?.focus();
    // Subscribe to WebOTP if available — auto-fills the code when the
    // SMS arrives. Chrome on Android (and Safari ≥ 17.4 on iOS).
    if (typeof window === "undefined") return;
    const w = window as typeof window & {
      OTPCredential?: unknown;
    };
    if (!("OTPCredential" in w)) return;
    const ac = new AbortController();
    otpAbortRef.current = ac;
    (navigator.credentials as CredentialsContainer & {
      get(o: {
        otp: { transport: string[] };
        signal: AbortSignal;
      }): Promise<{ code: string } | null>;
    })
      .get({
        otp: { transport: ["sms"] },
        signal: ac.signal,
      })
      .then((cred: { code: string } | null) => {
        if (cred?.code) {
          setCode(cred.code);
          // Auto-submit on autofill — feels magical.
          void verify(cred.code);
        }
      })
      .catch(() => {
        // AbortError or "no OTP" — both fine. Fall back to manual entry.
      });
    return () => ac.abort();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function startVerification() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.authPhoneStart(phone.trim());
      setDevCode(r.dev_code);
      if (r.dev_code) setCode(r.dev_code);
      setStep("code");
    } catch (e) {
      setError(formatError((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function verify(forCode?: string) {
    const c = (forCode ?? code).trim();
    if (c.length !== 6) {
      setError("Code must be 6 digits");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const p = await api.authPhoneVerify(c);
      onVerified(p);
      onClose();
    } catch (e) {
      setError(formatError((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={step === "phone" ? "Add phone" : "Enter verification code"}
      desktopMaxWidth="sm"
    >

        <div className="px-4 py-3">
          {step === "phone" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void startVerification();
              }}
            >
              <label className="mb-3 block">
                <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
                  Phone number
                </span>
                <input
                  ref={phoneRef}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+14155551234"
                  className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
                />
                <span className="mt-1 block text-[10px] text-neutral-500 dark:text-neutral-400">
                  Include the country code (E.164 — e.g.{" "}
                  <code className="font-mono">+1</code> for US/Canada,{" "}
                  <code className="font-mono">+44</code> for UK).
                </span>
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
                <ActionButton
                  type="submit"
                  disabled={busy || !/^\+[1-9]\d{6,}/.test(phone.trim())}
                >
                  {busy ? "Sending…" : "Send code"}
                </ActionButton>
              </div>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <p className="mb-2 text-xs text-neutral-700 dark:text-neutral-300">
                We sent a 6-digit code to{" "}
                <span className="font-mono">{phone.trim()}</span>.
              </p>
              {devCode && (
                <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  Dev mode — SMS not actually sent. Code is{" "}
                  <span className="font-mono font-semibold">{devCode}</span>.
                </p>
              )}
              <label className="mb-3 block">
                <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
                  Verification code
                </span>
                <input
                  ref={codeRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="••••••"
                  className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-center font-mono text-lg tracking-[0.5em] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
                />
              </label>
              {error && (
                <p className="mb-2 text-xs text-red-700 dark:text-red-300">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setStep("phone")}
                  className="text-[11px] text-neutral-600 hover:underline dark:text-neutral-400"
                >
                  ← Change number
                </button>
                <div className="flex gap-2">
                  <Pill type="button" onClick={onClose}>
                    Cancel
                  </Pill>
                  <ActionButton
                    type="submit"
                    disabled={busy || code.length !== 6}
                  >
                    {busy ? "Verifying…" : "Verify"}
                  </ActionButton>
                </div>
              </div>
            </form>
          )}
        </div>
    </BottomSheet>
  );
}

function formatError(raw: string): string {
  // jsonFetch errors look like "401 Unauthorized: incorrect code".
  // Strip the status prefix when we can — feels less like a stack trace.
  const m = raw.match(/^\d{3}\s+\w+:?\s*(.*)$/);
  return m && m[1] ? m[1] : raw;
}
