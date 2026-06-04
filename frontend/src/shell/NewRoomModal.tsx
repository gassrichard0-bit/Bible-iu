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
    <BottomSheet open={open} onClose={onClose} title="New room">

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="px-4 py-3"
        >
          <label className="mb-3 block">
            <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
              Name
            </span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="e.g. Romans 8 study"
              className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
            <span className="mt-1 block text-[10px] text-neutral-500 dark:text-neutral-400">
              {trimmed.length}/60
            </span>
          </label>

          <fieldset className="mb-3">
            <legend className="mb-1 text-[11px] text-neutral-600 dark:text-neutral-300">
              Type
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <TypeOption
                checked={type === "group"}
                onClick={() => setType("group")}
                title="Group"
                description="Shared study room — multiple people, shared (group-scope) notes."
              />
              <TypeOption
                checked={type === "direct"}
                onClick={() => setType("direct")}
                title="Direct"
                description="Just you (for now) — useful as a personal scratch space."
              />
            </div>
          </fieldset>

          <label className="mb-3 block">
            <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
              Description (optional)
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={240}
              rows={2}
              placeholder="What's this room for?"
              className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>

          {error && (
            <p className="mb-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || busy}
              className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {busy ? "Creating…" : "Create room"}
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
}: {
  checked: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-2 text-left text-xs transition ${
        checked
          ? "border-neutral-900 bg-paper-soft dark:border-neutral-100 dark:bg-neutral-800"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
      }`}
      aria-pressed={checked}
    >
      <div className="font-medium">{title}</div>
      <div className="mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400">
        {description}
      </div>
    </button>
  );
}
