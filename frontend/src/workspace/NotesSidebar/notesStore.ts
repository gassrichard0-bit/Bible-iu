/**
 * Shared note state for the room.
 *
 * notes-system.MD §5.6: "One note, two live views. The inline dropdown
 * and the Notes sidebar render the **same underlying note** … An edit
 * made inline appears instantly in the sidebar and vice versa."
 *
 * Until the Yjs substrate (notes-system.MD §3.1) lands, this is just a
 * React state object lifted to the shell, exposed through a typed API.
 */

export interface NoteRow {
  id: string;
  scope: "personal" | "group";
  body: string;
  verse_anchor?: string;
  by_agent?: boolean;
  /** User id of whoever created this note. Set when the note is
   *  added; absent on legacy rows written before this field existed
   *  (those fall through the delete-permission check as "unknown
   *  author" and stay deletable so old data doesn't get orphaned). */
  author_user_id?: string;
  /** Handle of the user who created the note, stamped at add time.
   *  Used by the renderer to label group notes by other members
   *  instead of always saying "You". Personal notes don't need it
   *  (they're only ever shown to their author) but we set it for
   *  consistency. Legacy rows leave this undefined and fall back
   *  to "You" in the UI. */
  author_handle?: string;
}

export interface NotesApi {
  notes: NoteRow[];
  add: (n: Omit<NoteRow, "id">) => string;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  forVerse: (verseId: string) => NoteRow[];
  /** Notes anchored to a whole chapter (no verse). The anchor format
   *  is `BOOK.CHAPTER` — same backbone as verse anchors but two
   *  dot-segments instead of three. */
  forChapter: (book: string, chapter: number) => NoteRow[];
}
