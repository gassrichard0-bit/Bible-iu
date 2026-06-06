/**
 * Real login + signup (CLAUDE.md §4.11).
 *
 * Backed by `/auth/register` and `/auth/login`. Stores the session
 * token in localStorage; subsequent API/WS calls include it. Sign-out
 * lives in the Settings modal.
 */
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { api, setSessionToken } from "../lib/api";
import type { Theme } from "../lib/theme";
import { GLASS_CARD } from "../lib/glass";
import { RecoverModal } from "./RecoverModal";

interface Props {
  onSignedIn: (handle: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export function Login({ onSignedIn, theme, onToggleTheme }: Props) {
  // First-time visitors land on "register" so the create-account path
  // is the obvious one. A localStorage flag set on first successful
  // sign-in flips the default back to "login" for repeat visits.
  const [mode, setMode] = useState<"login" | "register">(() => {
    if (typeof window === "undefined") return "login";
    return localStorage.getItem("bible-iu:has-signed-in") === "1"
      ? "login"
      : "register";
  });
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoverOpen, setRecoverOpen] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === "register"
          ? await api.authRegister(handle.trim(), password, displayName.trim() || undefined)
          : await api.authLogin(handle.trim(), password);
      setSessionToken(session.token);
      // Remember this device has signed in at least once — next visit
      // defaults to the Sign-in tab instead of Create account.
      try {
        localStorage.setItem("bible-iu:has-signed-in", "1");
      } catch {
        // localStorage can throw in private windows on Safari; harmless.
      }
      onSignedIn(session.handle);
    } catch (e) {
      const msg = (e as Error).message ?? "auth failed";
      if (msg.startsWith("401")) {
        setError("Wrong handle or password.");
      } else if (msg.startsWith("409")) {
        setError("That handle is already taken.");
      } else if (msg.startsWith("400")) {
        setError(
          "Handle must be 2-32 chars (letters, digits, _ or -); password 8+ chars.",
        );
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid h-full place-items-center bg-paper-soft dark:bg-neutral-950">
      <div className="absolute right-3 top-3">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      <form
        onSubmit={submit}
        className={`w-full max-w-sm p-6 ${GLASS_CARD}`}
      >
        <h1 className="mb-3 text-lg font-semibold">Bible IU</h1>
        <div
          className="mb-4 flex rounded-2xl border border-neutral-200 bg-neutral-100/60 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-700 dark:bg-neutral-800/60 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
          role="tablist"
          aria-label="Auth mode"
        >
          <button
            type="button"
            onClick={() => {
              if (mode === "register") {
                setMode("register");
                return;
              }
              setMode("register");
              setError(null);
            }}
            role="tab"
            aria-selected={mode === "register"}
            className={`flex-1 rounded-xl px-2 py-2 text-[13px] font-semibold transition ${
              mode === "register"
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            Create account
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setError(null);
            }}
            role="tab"
            aria-selected={mode === "login"}
            className={`flex-1 rounded-xl px-2 py-2 text-[13px] font-semibold transition ${
              mode === "login"
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            Sign in
          </button>
        </div>
        <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          {mode === "register"
            ? "Pick a handle (2–32 chars) and a password (8+ chars). No email required."
            : "Welcome back."}
        </p>

        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Handle
        </label>
        <input
          autoFocus
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          autoComplete="username"
          className="mt-1 w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          placeholder="alex"
        />

        <label className="mt-3 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          className="mt-1 w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          placeholder="••••••••"
        />

        {mode === "register" && (
          <>
            <label className="mt-3 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Display name <span className="text-neutral-400">(optional)</span>
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
              placeholder="Alex"
            />
          </>
        )}

        {error && (
          <p className="mt-3 text-xs text-red-700 dark:text-red-300">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !handle.trim() || password.length < 8}
          className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-2xl bg-neutral-900 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy ? "…" : mode === "register" ? "Create account" : "Sign in"}
        </button>

        {mode === "login" && (
          <button
            type="button"
            onClick={() => setRecoverOpen(true)}
            className="mt-3 w-full text-center text-[11px] text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Forgot password?
          </button>
        )}
      </form>
      <RecoverModal
        open={recoverOpen}
        onClose={() => setRecoverOpen(false)}
        onRecovered={(s) => onSignedIn(s.handle)}
      />
    </div>
  );
}
