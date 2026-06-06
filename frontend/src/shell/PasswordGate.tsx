/**
 * Front-door password prompt.
 *
 * Shown before the rest of the app loads if (a) no password is stored,
 * or (b) the backend rejects the stored one with 401. The backend skips
 * this gate entirely if `BIBLE_IU_PASSWORD` is unset on the server.
 *
 * `TODO(spec)`: replace with real auth (CLAUDE.md §4.11, §14).
 */
import { useState } from "react";
import { setPassword } from "../lib/api";
import { GLASS_CARD } from "../lib/glass";

interface Props {
  onUnlock: () => void;
  message?: string;
}

export function PasswordGate({ onUnlock, message }: Props) {
  const [value, setValue] = useState("");
  return (
    <div className="grid h-full place-items-center bg-paper-soft dark:bg-neutral-950">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setPassword(value.trim());
          onUnlock();
        }}
        className={`w-full max-w-sm p-6 ${GLASS_CARD}`}
      >
        <h1 className="mb-1 text-lg font-semibold">Bible IU</h1>
        <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
          {message ??
            "This instance is password-protected. Enter the shared password to continue."}
        </p>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          placeholder="Password"
        />
        <button
          type="submit"
          className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-2xl bg-neutral-900 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
