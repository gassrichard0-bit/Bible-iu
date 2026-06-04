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
        className={`w-80 p-6 ${GLASS_CARD}`}
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
          className="mt-1 w-full rounded border border-neutral-300 bg-paper px-2 py-2 text-sm focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          placeholder="Password"
        />
        <button
          type="submit"
          className="mt-4 w-full rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-paper"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
