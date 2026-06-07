/**
 * Single source of truth for "can this user delete this note?".
 *
 * Rule: only the author may delete. Personal notes are by definition
 * author-only (the privacy boundary already keeps them invisible to
 * everyone else), so the check is mainly meaningful for group notes
 * where multiple users see the same row.
 *
 * Legacy fallback: rows created before the `author_user_id` field
 * existed don't carry one. Treating them as undeletable would orphan
 * old data, so we allow the delete in that case. New notes (written
 * after this change) always set author_user_id, so the strict check
 * applies to them.
 *
 * Agent-authored notes (`by_agent === true`) have no human author —
 * the field is intentionally unset there. For now we let any room
 * member remove them; revisit if we want admin-only.
 */
import type { NoteRow } from "./notesStore";

export function canDeleteNote(
  note: NoteRow,
  selfUserId: string | undefined,
): boolean {
  if (note.by_agent) return true; // system-generated, no human author
  // Personal notes are only ever visible to their author (the privacy
  // boundary), so "can delete" is always true for the viewer. Legacy
  // personal rows missing author_user_id still match this branch.
  if (note.scope === "personal") return true;
  if (!selfUserId) return false; // not signed in → can't claim ownership
  if (!note.author_user_id) {
    // Legacy GROUP note with no recorded author. Used to fall through
    // to "allow," but that meant every member saw a working X on
    // anyone's old note. Deny to match the new strict rule; old
    // owners can still delete via a future "rescue" path if needed.
    return false;
  }
  return note.author_user_id === selfUserId;
}
