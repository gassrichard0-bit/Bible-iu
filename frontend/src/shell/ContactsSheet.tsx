/**
 * Contacts sheet — shown when the user taps the contacts icon on the
 * top app bar of the Chat tab. Lists every person the caller shares
 * at least one room with. Tap a contact → opens (or finds) a 1:1 DM
 * with them via api.dmOpen.
 *
 * Includes a search field that filters by display name + handle.
 */
import { useEffect, useState } from "react";
import { api, type ContactView } from "../lib/api";
import { Avatar } from "./Profile";
import { BottomSheet } from "./BottomSheet";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired when the user taps a contact — parent calls api.dmOpen and
   *  switches the active room. */
  onPick: (userId: string) => void;
}

export function ContactsSheet({ open, onClose, onPick }: Props) {
  const [contacts, setContacts] = useState<ContactView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setQuery("");
    api
      .contactsList()
      .then((c) => alive && setContacts(c))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = (contacts ?? []).filter((c) => {
    if (!q) return true;
    return (
      c.display_name.toLowerCase().includes(q) ||
      c.handle.toLowerCase().includes(q)
    );
  });

  return (
    <BottomSheet open={open} onClose={onClose} title="Contacts">
      <div className="flex flex-col gap-3 px-4 pb-5 pt-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search contacts…"
          aria-label="Search contacts"
          className="w-full rounded-full border border-neutral-200 bg-paper px-3.5 py-2 text-[14px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
        />
        {contacts === null && !error && (
          <p className="px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
            Loading contacts…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}
        {contacts !== null && contacts.length === 0 && (
          <div className="mx-auto rounded-2xl border border-neutral-200 bg-paper px-4 py-5 text-center text-[13px] text-neutral-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            No contacts yet. Join or create a group to start meeting
            people you can message.
          </div>
        )}
        {contacts !== null && contacts.length > 0 && filtered.length === 0 && (
          <p className="px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
            No matches for "{query}"
          </p>
        )}
        {filtered.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onPick(c.id)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-paper px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] transition hover:bg-paper-soft active:scale-[0.99] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:bg-neutral-800"
                >
                  <Avatar handle={c.handle} url={c.avatar_url} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
                      {c.display_name || c.handle}
                    </span>
                    <span className="block truncate font-mono text-[12px] text-neutral-500 dark:text-neutral-400">
                      @{c.handle}
                    </span>
                  </span>
                  <span className="text-neutral-400" aria-hidden>
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}
