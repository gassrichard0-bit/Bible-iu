/**
 * Yjs-backed `NotesApi` (CLAUDE.md §8, notes-system.MD §3.1).
 *
 * One Y.Doc per room (mounted at `/ws/yjs/{roomId}`). Each note is a
 * Y.Map entry inside a top-level Y.Array called "notes". CRDT semantics
 * mean concurrent edits across browser tabs / devices merge without
 * conflict.
 *
 * Note bodies are `Y.Text` so two users typing the SAME note merge
 * letter-by-letter via CRDT instead of last-write-wins. Textarea edits
 * are converted to Y.Text ops via a minimal prefix/suffix diff —
 * good enough for plain textareas; TipTap binding is the spec'd
 * upgrade path for the rich editor (notes-system.MD §3.1).
 *
 * Local persistence via y-indexeddb survives tab close / offline.
 */
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import type {
  NoteRow,
  NotesApi,
} from "./notesStore";
import { getPassword, getSessionToken } from "../../lib/api";

interface YNote {
  id: string;
  scope: "personal" | "group";
  body: string;
  verse_anchor?: string;
  by_agent?: boolean;
}

/** Snapshot the Y.Array of notes into a plain NoteRow[]. Y.Text bodies
 *  are flattened to plain strings for UI consumption; the underlying
 *  Y.Text still merges concurrent edits internally. */
function snapshot(arr: Y.Array<Y.Map<unknown>>): NoteRow[] {
  const out: NoteRow[] = [];
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i) as Y.Map<unknown>;
    const id = (m.get("id") as string) ?? "";
    const scope = (m.get("scope") as YNote["scope"]) ?? "personal";
    const rawBody = m.get("body");
    const body =
      rawBody instanceof Y.Text
        ? rawBody.toString()
        : ((rawBody as string) ?? "");
    const va = m.get("verse_anchor");
    const by = m.get("by_agent");
    out.push({
      id,
      scope,
      body,
      verse_anchor: typeof va === "string" ? va : undefined,
      by_agent: typeof by === "boolean" ? by : undefined,
    });
  }
  return out;
}


/** Convert a textarea change into incremental Y.Text ops by diffing
 *  the new value against the current Y.Text. Common prefix + suffix
 *  are preserved; only the middle is replaced — so two users typing
 *  in different parts of the same note merge cleanly. */
function applyDiffToYText(yText: Y.Text, next: string): void {
  const current = yText.toString();
  if (current === next) return;

  let prefix = 0;
  while (
    prefix < current.length &&
    prefix < next.length &&
    current.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) prefix++;

  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current.charCodeAt(current.length - 1 - suffix) ===
      next.charCodeAt(next.length - 1 - suffix)
  ) suffix++;

  const deleteLen = current.length - prefix - suffix;
  const insertText = next.slice(prefix, next.length - suffix);

  yText.doc?.transact(() => {
    if (deleteLen > 0) yText.delete(prefix, deleteLen);
    if (insertText) yText.insert(prefix, insertText);
  });
}

export interface YjsRoomHandle {
  doc: Y.Doc;
  notes: Y.Array<Y.Map<unknown>>;
  api: NotesApi;
  cleanup: () => void;
}

/** Hook: returns a NotesApi backed by the room's Y.Doc, synced via
 *  WebSocket. Reconnects automatically on network drop. */
export function useYjsNotes(roomId: string): NotesApi {
  // Build (and tear down) a fresh Y.Doc + provider when the room changes.
  const handle = useMemo(() => buildHandle(roomId), [roomId]);
  useEffect(() => {
    return () => handle.cleanup();
  }, [handle]);

  const [, force] = useState(0);
  useEffect(() => {
    const observer = () => force((n) => n + 1);
    handle.notes.observeDeep(observer);
    return () => handle.notes.unobserveDeep(observer);
  }, [handle]);

  // Recompute the NotesApi each render so the consumer always sees a
  // fresh `notes` array (otherwise React's reference-equality misses
  // CRDT mutations even though they came in via observe).
  const rows = snapshot(handle.notes);
  return {
    notes: rows,
    add: (n) => handle.api.add(n),
    update: (id, body) => handle.api.update(id, body),
    remove: (id) => handle.api.remove(id),
    forVerse: (verseId) => rows.filter((r) => r.verse_anchor === verseId),
    forChapter: (book, chapter) => {
      const anchor = `${book}.${chapter}`;
      return rows.filter((r) => r.verse_anchor === anchor);
    },
  };
}

function buildHandle(roomId: string): YjsRoomHandle {
  // No active room yet (rail still loading). Return a no-op handle —
  // calling `connect` with an empty room ID gives the URL
  // `/ws/yjs/?password=…` which doesn't match the FastAPI route and
  // floods the console with 403s.
  if (!roomId) {
    const doc = new Y.Doc();
    const notes = doc.getArray<Y.Map<unknown>>("notes");
    return {
      doc,
      notes,
      api: {
        notes: [],
        add: () => "",
        update: () => {},
        remove: () => {},
        forVerse: () => [],
      forChapter: () => [],
      },
      cleanup: () => doc.destroy(),
    };
  }
  const doc = new Y.Doc();
  const notes = doc.getArray<Y.Map<unknown>>("notes");

  // Offline-first: IndexedDB is the authoritative local store. The
  // websocket provider is the sync channel to the server (and across
  // tabs). When offline, edits accumulate in IndexedDB and flush on
  // reconnect.
  const persistence = new IndexeddbPersistence(`notes-${roomId}`, doc);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/yjs`;
  const provider = new WebsocketProvider(url, roomId, doc, {
    params: {
      password: getPassword(),
      session: getSessionToken(),
    },
    // protocols default ['yjs'] which pycrdt accepts.
  });

  const api: NotesApi = {
    notes: [], // consumed via snapshot, not this field
    add: (n) => {
      const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const m = new Y.Map();
      m.set("id", id);
      m.set("scope", n.scope);
      // Body is a Y.Text so concurrent edits merge per-character.
      const body = new Y.Text();
      if (n.body) body.insert(0, n.body);
      m.set("body", body);
      if (n.verse_anchor) m.set("verse_anchor", n.verse_anchor);
      if (n.by_agent) m.set("by_agent", n.by_agent);
      notes.push([m]);
      return id;
    },
    update: (id, body) => {
      doc.transact(() => {
        for (let i = 0; i < notes.length; i++) {
          const m = notes.get(i) as Y.Map<unknown>;
          if (m.get("id") !== id) continue;
          const existing = m.get("body");
          if (existing instanceof Y.Text) {
            applyDiffToYText(existing, body);
          } else {
            // Legacy string body — upgrade to Y.Text in place.
            const yt = new Y.Text();
            if (body) yt.insert(0, body);
            m.set("body", yt);
          }
          return;
        }
      });
    },
    remove: (id) => {
      doc.transact(() => {
        for (let i = 0; i < notes.length; i++) {
          const m = notes.get(i) as Y.Map<unknown>;
          if (m.get("id") === id) {
            notes.delete(i, 1);
            return;
          }
        }
      });
    },
    forVerse: () => [],
    forChapter: () => [],
  };

  return {
    doc,
    notes,
    api,
    cleanup: () => {
      provider.destroy();
      persistence.destroy();
      doc.destroy();
    },
  };
}
