/**
 * Local-only "seen notes" tracker.
 *
 * The note row has no read/unread flag — `NoteRow` doesn't even
 * carry created_at or author_user_id (see notesStore.ts). We treat
 * "unread" as "the note id isn't in this device's seen set yet."
 *
 * First mount in a (room, user) seeds the seen set with every existing
 * note id so the "Unread" view starts at zero — otherwise a freshly
 * installed device would mark months of history as unread. After that,
 * any note that appears whose id isn't in the set is unread until the
 * user views it (we mark seen on render of the Unread list or via
 * "Mark all read").
 *
 * Stored under `bible-iu:notes-seen:<roomId>:<userId>` so multiple
 * accounts and rooms on the same browser don't bleed state into each
 * other.
 */

function key(roomId: string | undefined, userId: string | undefined): string {
  return `bible-iu:notes-seen:${roomId ?? "_"}:${userId ?? "_"}`;
}

export function loadSeenSet(
  roomId: string | undefined,
  userId: string | undefined,
): Set<string> {
  try {
    const raw = localStorage.getItem(key(roomId, userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveSeenSet(
  roomId: string | undefined,
  userId: string | undefined,
  seen: Set<string>,
): void {
  try {
    // Cap the saved size — old notes rotate out as the room grows.
    // 5000 ids ~= 200KB, well under the 5MB localStorage budget.
    const arr = Array.from(seen).slice(-5000);
    localStorage.setItem(key(roomId, userId), JSON.stringify(arr));
    // Same-tab signal — `storage` only fires across tabs, so without
    // this the NotesSidebar marking a note seen wouldn't refresh the
    // MobileShell tab badge until a navigation.
    window.dispatchEvent(new Event("bible-iu:notes-seen-changed"));
  } catch {
    // best-effort — localStorage may be unavailable or full
  }
}

const INIT_KEY_SUFFIX = ":init";

/** Returns true if this (room, user) has never had its seen set
 *  initialized. First call returns true once, then false forever. */
export function consumeInitFlag(
  roomId: string | undefined,
  userId: string | undefined,
): boolean {
  try {
    const k = key(roomId, userId) + INIT_KEY_SUFFIX;
    if (localStorage.getItem(k)) return false;
    localStorage.setItem(k, "1");
    return true;
  } catch {
    return false;
  }
}

import { useEffect, useState } from "react";

/** Number of notes whose id isn't yet in the seen set. Re-reads
 *  localStorage on storage events so NotesSidebar marking notes seen
 *  reflects in the MobileShell tab badge without prop drilling. */
export function useUnreadNoteCount(
  noteIds: string[],
  roomId: string | undefined,
  userId: string | undefined,
): number {
  const [seenVersion, setSeenVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setSeenVersion((v) => v + 1);
    window.addEventListener("storage", refresh);
    window.addEventListener("bible-iu:notes-seen-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("bible-iu:notes-seen-changed", refresh);
    };
  }, []);
  void seenVersion;
  const seen = loadSeenSet(roomId, userId);
  let n = 0;
  for (const id of noteIds) if (!seen.has(id)) n++;
  return n;
}
