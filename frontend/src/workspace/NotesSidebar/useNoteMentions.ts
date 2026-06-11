/**
 * Watch a group note's body for `@handle` mentions and POST them to
 * the backend so the tagged member gets a Web Push. The backend
 * dedupes per (note_id, user_id) via a unique constraint, so calling
 * this on every body change is safe — repeats are no-ops.
 *
 * Scope rules:
 *   - Only fires when `scope === "group"` and we have a real `noteId`
 *     and `roomId`. Personal notes never leave the author so there's
 *     no one to ping.
 *   - The regex requires a leading whitespace or BOM and matches
 *     `@[a-z0-9_]{1,32}` (case-insensitive). Word-boundary alone
 *     wouldn't work because `foo@bar` would match `@bar`.
 *
 * Tuning:
 *   - 1500ms debounce — long enough that a typo + correction doesn't
 *     fire a wasted POST, short enough that the user usually sees the
 *     "tagged" toast before they navigate away.
 */
import { useEffect, useRef } from "react";
import { api } from "../../lib/api";

// Strip HTML so the regex matches the actual text the user typed,
// not class-attribute fragments etc.
function stripHtml(s: string): string {
  return s
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const MENTION_RE = /(^|\s)@([a-z0-9_]{1,32})/gi;

export function extractMentionHandles(html: string): string[] {
  const text = stripHtml(html || "");
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    seen.add(m[2].toLowerCase());
  }
  return [...seen];
}

export function useNoteMentions(
  scope: "personal" | "group" | undefined,
  roomId: string | undefined,
  noteId: string | undefined,
  body: string | undefined,
): void {
  const timerRef = useRef<number | null>(null);
  // Track which handles we've already posted for THIS note this session
  // so a small body edit (e.g. fixing punctuation) doesn't re-POST the
  // same handles. The server dedupes for real via the unique
  // constraint; this avoids the network noise.
  const postedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    postedRef.current = new Set();
  }, [noteId]);
  useEffect(() => {
    if (scope !== "group") return;
    if (!roomId || !noteId || !body) return;
    const handles = extractMentionHandles(body);
    if (handles.length === 0) return;
    const fresh = handles.filter((h) => !postedRef.current.has(h));
    if (fresh.length === 0) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      api
        .noteMention(roomId, noteId, fresh)
        .then(() => {
          for (const h of fresh) postedRef.current.add(h);
        })
        .catch(() => {
          // Silent — a 4xx here usually means the note isn't a
          // registered group note yet (race with the register POST),
          // and the next body change will retry the same handles.
        });
    }, 1500);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [scope, roomId, noteId, body]);
}
