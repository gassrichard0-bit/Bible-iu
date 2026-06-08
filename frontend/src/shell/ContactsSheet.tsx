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
import { JumpIcon } from "../lib/Icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired when the user taps a contact. Parent should open the
   *  profile preview sheet (not a DM directly). The `preview` mirrors
   *  the chat-bubble avatar-tap shape so MobileShell can reuse the
   *  same profileView state for both entry points. */
  onPick: (
    userId: string,
    preview: {
      handle: string | null;
      displayName: string | null;
      avatarUrl: string | null;
    },
  ) => void;
  /** Currently active GROUP room (not direct chat). When set, the
   *  "Invite" button mints a real RoomInvite token and shares
   *  `<origin>/?invite=<code>` so the recipient joins the group
   *  automatically after signup. Null = fall back to a generic
   *  app URL (no auto-join). */
  inviteRoom?: { id: string; name: string } | null;
  /** When set, the contact list is scoped to JUST this room's
   *  members. The chat Contacts sheet passes the currently-open
   *  room here so the list always matches what the user is looking
   *  at. Without it, falls back to the user's full cross-room
   *  contact set. */
  scopeRoomId?: string | null;
}

export function ContactsSheet({
  open,
  onClose,
  onPick,
  inviteRoom,
  scopeRoomId,
}: Props) {
  const [contacts, setContacts] = useState<ContactView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setQuery("");
    setInviteCopied(false);
    setContacts(null);
    api
      .contactsList(scopeRoomId ?? undefined)
      .then((c) => alive && setContacts(c))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [open, scopeRoomId]);

  const [inviteBusy, setInviteBusy] = useState(false);

  async function shareInvite() {
    if (inviteBusy) return;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    setInviteBusy(true);
    let url = origin;
    let text =
      "I'm using Bible IU to study + chat about scripture. Join me — it's a free app.";
    // When the user is sitting in a group room, mint a real RoomInvite
    // so the recipient is auto-added to that group after signing up
    // (same flow as the existing "Share room link" modal). Falls back
    // to the bare origin if no group is active or the request fails.
    if (inviteRoom) {
      try {
        const inv = await api.createInvite(inviteRoom.id, 7, null);
        url = `${origin}/?invite=${inv.code}`;
        text = `Join my Bible IU group "${inviteRoom.name}" — open the link to come right in.`;
      } catch {
        // best-effort — keep the generic URL
      }
    }
    setInviteBusy(false);
    try {
      const nav = navigator as Navigator & {
        share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      };
      if (nav.share) {
        await nav.share({ title: "Bible IU", text, url });
        return;
      }
    } catch {
      // user dismissed the share sheet — silently fall through
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      // best-effort
    }
  }

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
        <button
          type="button"
          onClick={() => void shareInvite()}
          disabled={inviteBusy}
          className="flex w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50/80 px-3 py-2.5 text-left shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition active:scale-[0.99] disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900/30 dark:shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]"
          aria-label={
            inviteRoom
              ? `Invite to ${inviteRoom.name}`
              : "Invite people to Bible IU"
          }
        >
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-200 text-amber-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:bg-amber-700/60 dark:text-amber-100"
            aria-hidden
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c.7-3.5 4-6 8-6 1.3 0 2.5.27 3.6.74" />
              <path d="M18 14v6" />
              <path d="M15 17h6" />
            </svg>
          </span>
          <span className="flex-1">
            <span className="block text-[15px] font-semibold text-amber-900 dark:text-amber-100">
              {inviteBusy
                ? "Generating link…"
                : inviteCopied
                  ? "✓ Link copied"
                  : inviteRoom
                    ? `Invite to "${inviteRoom.name}"`
                    : "Invite to Bible IU"}
            </span>
            <span className="block text-[11px] text-amber-700/80 dark:text-amber-200/80">
              {inviteCopied
                ? "Paste it anywhere"
                : inviteRoom
                  ? "Single-tap join — they're added to the group after signing up"
                  : "Share a link via Messages, email, anything"}
            </span>
          </span>
          <span className="text-amber-700/80 dark:text-amber-200/70" aria-hidden>
            <JumpIcon className="h-4 w-4" />
          </span>
        </button>
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
                  onClick={() =>
                    onPick(c.id, {
                      handle: c.handle,
                      displayName: c.display_name,
                      avatarUrl: c.avatar_url,
                    })
                  }
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
