/**
 * New Room modal — replaces the native `prompt()` previously used by
 * the `+ New room` button in the rail.
 *
 * Just a presentational dialog: collects name + type + optional
 * description, validates, and hands them back to the caller. The
 * caller owns the actual `api.createRoom` call so it can still fall
 * back to a local-only entry if the backend is unreachable.
 */
import { useEffect, useRef, useState } from "react";
import { BottomSheet } from "./BottomSheet";

export interface NewRoomValues {
  name: string;
  type: "group" | "direct";
  description: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (values: NewRoomValues) => Promise<void> | void;
}

export function NewRoomModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"group" | "direct">("group");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setType("group");
      setDescription("");
      setError(null);
      // Focus on the next tick so the input is mounted.
      const t = setTimeout(() => nameRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= 60;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: trimmed,
        type,
        description: description.trim(),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message || "Could not create room");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="New group" fullPage>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="mx-auto flex h-full max-w-md flex-col gap-5 px-4 py-5"
      >
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Group name
          </span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Romans 8 study"
            className="w-full rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          />
          <span className="mt-1 block text-[11px] text-neutral-400 dark:text-neutral-500">
            {trimmed.length}/60
          </span>
        </label>

        <fieldset>
          <legend className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Type
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <TypeOption
              checked={type === "group"}
              onClick={() => setType("group")}
              title="Group"
              description="Shared study room — multiple people, shared notes."
              icon={
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="9" cy="8" r="3.5" />
                  <circle cx="17" cy="9" r="2.5" />
                  <path d="M3.5 18.5c.6-2.6 2.9-4.5 5.5-4.5s4.9 1.9 5.5 4.5" />
                  <path d="M15.5 18c.3-1.6 1.8-2.8 3.5-2.8s3.2 1.2 3.5 2.8" />
                </svg>
              }
            />
            <TypeOption
              checked={type === "direct"}
              onClick={() => setType("direct")}
              title="Direct"
              description="Just you for now — a personal scratch space."
              icon={
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c.7-3.5 4-6 8-6s7.3 2.5 8 6" />
                </svg>
              }
            />
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Description <span className="font-normal normal-case text-neutral-400">(optional)</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={240}
            rows={3}
            placeholder="What's this group for?"
            className="w-full resize-none rounded-2xl border border-neutral-200 bg-paper px-3.5 py-3 text-[14px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          />
        </label>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <div className="mt-auto flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-neutral-300 bg-paper px-4 py-3 text-[14px] font-medium text-neutral-700 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="rounded-2xl bg-neutral-900 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900"
          >
            {busy ? "Creating…" : type === "group" ? "Create group" : "Create"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function TypeOption({
  checked,
  onClick,
  title,
  description,
  icon,
}: {
  checked: boolean;
  onClick: () => void;
  title: string;
  description: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={`flex items-start gap-3 rounded-2xl border px-3 py-3 text-left transition ${
        checked
          ? "border-amber-300 bg-amber-50/70 shadow-sm ring-2 ring-amber-200/50 dark:border-amber-700 dark:bg-amber-900/30 dark:ring-amber-800/40"
          : "border-neutral-200 bg-paper hover:border-neutral-300 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      }`}
    >
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
          checked
            ? "bg-amber-200 text-amber-900 dark:bg-amber-700/60 dark:text-amber-100"
            : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        }`}
      >
        {icon}
      </span>
      <span className="flex-1">
        <span className="block text-[14px] font-semibold text-neutral-900 dark:text-neutral-50">
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] text-neutral-500 dark:text-neutral-400">
          {description}
        </span>
      </span>
    </button>
  );
}
