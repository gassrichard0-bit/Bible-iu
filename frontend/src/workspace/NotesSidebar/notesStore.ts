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
}

export interface NotesApi {
  notes: NoteRow[];
  add: (n: Omit<NoteRow, "id">) => string;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  forVerse: (verseId: string) => NoteRow[];
}
