/**
 * Yjs-backed `NotesApi` (CLAUDE.md §8, notes-system.MD §3.1).
 *
 * SCOPING — WhatsApp-group-style isolation:
 *   • Group notes live in the room's SHARED Y.Doc `{roomId}`. Every
 *     member sees the same CRDT state; concurrent edits merge.
 *   • Personal notes live in a per-user PRIVATE Y.Doc
 *     `notes_private__{userId}__{roomId}`. The backend rejects any
 *     websocket connection where the session token doesn't match the
 *     `{userId}` in the doc name, so other room members literally
 *     cannot subscribe to your private doc.
 *
 * The hook merges both docs for the UI — caller doesn't see the split.
 *
 * Note bodies are `Y.Text` so two of the user's own devices typing the
 * same note merge letter-by-letter.
 *
 * Local persistence: y-indexeddb keeps the SHARED doc and the PRIVATE
 * doc in separate IndexedDB databases, so wiping one doesn't touch
 * the other.
 */
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import type { NoteRow, NotesApi } from "./notesStore";
import {
  api as serverApi,
  getPassword,
  getSessionToken,
} from "../../lib/api";

interface YNote {
  id: string;
  scope: "personal" | "group";
  body: string;
  verse_anchor?: string;
  by_agent?: boolean;
}

/** Snapshot a single Y.Array of notes into a plain NoteRow[]. */
function snapshotArray(arr: Y.Array<Y.Map<unknown>>): NoteRow[] {
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

/** Convert a textarea change into incremental Y.Text ops. */
function applyDiffToYText(yText: Y.Text, next: string): void {
  const current = yText.toString();
  if (current === next) return;

  let prefix = 0;
  while (
    prefix < current.length &&
    prefix < next.length &&
    current.charCodeAt(prefix) === next.charCodeAt(prefix)
  )
    prefix++;

  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current.charCodeAt(current.length - 1 - suffix) ===
      next.charCodeAt(next.length - 1 - suffix)
  )
    suffix++;

  const deleteLen = current.length - prefix - suffix;
  const insertText = next.slice(prefix, next.length - suffix);

  yText.doc?.transact(() => {
    if (deleteLen > 0) yText.delete(prefix, deleteLen);
    if (insertText) yText.insert(prefix, insertText);
  });
}

interface DocBundle {
  doc: Y.Doc;
  notes: Y.Array<Y.Map<unknown>>;
  provider: WebsocketProvider;
  persistence: IndexeddbPersistence;
}

export interface YjsRoomHandle {
  /** Shared room doc — group notes only. */
  group: DocBundle;
  /** Per-user private doc — personal notes only. null if not signed in. */
  personal: DocBundle | null;
  api: NotesApi;
  cleanup: () => void;
}

/** Hook: returns a NotesApi backed by two Y.Docs (one shared, one
 *  private) and a merged in-memory view. */
export function useYjsNotes(roomId: string, userId?: string): NotesApi {
  const handle = useMemo(
    () => buildHandle(roomId, userId),
    [roomId, userId],
  );
  useEffect(() => {
    return () => handle.cleanup();
  }, [handle]);

  // Force a re-snapshot when EITHER doc changes — the consumer sees a
  // unified list.
  const [, force] = useState(0);
  useEffect(() => {
    const observer = () => force((n) => n + 1);
    handle.group.notes.observeDeep(observer);
    handle.personal?.notes.observeDeep(observer);
    return () => {
      handle.group.notes.unobserveDeep(observer);
      handle.personal?.notes.unobserveDeep(observer);
    };
  }, [handle]);

  // Snapshot strategy:
  //   group doc → only `scope === "group"` rows are real. Any
  //     `scope === "personal"` row there is legacy / leaked data from
  //     before the per-user split; we drop it on read so it can't be
  //     shown in the UI.
  //   personal doc → all rows are this user's; surface them as-is.
  const groupRows = snapshotArray(handle.group.notes).filter(
    (r) => r.scope === "group",
  );
  const personalRows = handle.personal
    ? snapshotArray(handle.personal.notes)
    : [];
  const rows: NoteRow[] = [...personalRows, ...groupRows];

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

function noopApi(): NotesApi {
  return {
    notes: [],
    add: () => "",
    update: () => {},
    remove: () => {},
    forVerse: () => [],
    forChapter: () => [],
  };
}

function buildHandle(roomId: string, userId?: string): YjsRoomHandle {
  // No active room → no-op handle.
  if (!roomId) {
    const doc = new Y.Doc();
    const stub: DocBundle = {
      doc,
      notes: doc.getArray<Y.Map<unknown>>("notes"),
      // Dummies so the cleanup() doesn't blow up.
      provider: undefined as unknown as WebsocketProvider,
      persistence: undefined as unknown as IndexeddbPersistence,
    };
    return {
      group: stub,
      personal: null,
      api: noopApi(),
      cleanup: () => doc.destroy(),
    };
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws/yjs`;
  const wsParams = {
    password: getPassword(),
    session: getSessionToken(),
  };

  // ---------- SHARED doc: group notes ----------
  const groupDoc = new Y.Doc();
  const groupNotes = groupDoc.getArray<Y.Map<unknown>>("notes");
  const groupPersistence = new IndexeddbPersistence(
    `notes-${roomId}`,
    groupDoc,
  );
  const groupProvider = new WebsocketProvider(wsUrl, roomId, groupDoc, {
    params: wsParams,
  });
  const group: DocBundle = {
    doc: groupDoc,
    notes: groupNotes,
    provider: groupProvider,
    persistence: groupPersistence,
  };

  // ---------- PRIVATE doc: personal notes ----------
  // Only built when we know who's signed in — the doc name encodes the
  // user id so the backend can validate. Without a userId we can't
  // safely subscribe to a per-user doc.
  let personal: DocBundle | null = null;
  if (userId) {
    const personalDoc = new Y.Doc();
    const personalNotes = personalDoc.getArray<Y.Map<unknown>>("notes");
    const personalDocName = `notes_private__${userId}__${roomId}`;
    const personalPersistence = new IndexeddbPersistence(
      `notes-private-${userId}-${roomId}`,
      personalDoc,
    );
    const personalProvider = new WebsocketProvider(
      wsUrl,
      personalDocName,
      personalDoc,
      { params: wsParams },
    );
    personal = {
      doc: personalDoc,
      notes: personalNotes,
      provider: personalProvider,
      persistence: personalPersistence,
    };
  }

  // ---------- routed mutations ----------
  // add: scope decides which doc receives the new note. Personal notes
  // fall back to the shared doc only if there's no personal doc yet
  // (not signed in) — but in that case the UI shouldn't be letting the
  // user create personal notes in the first place.
  // update/remove: locate by id across both docs.
  const localId = () =>
    `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  function findInDoc(
    bundle: DocBundle,
    id: string,
  ): { arr: Y.Array<Y.Map<unknown>>; index: number } | null {
    for (let i = 0; i < bundle.notes.length; i++) {
      const m = bundle.notes.get(i) as Y.Map<unknown>;
      if (m.get("id") === id) return { arr: bundle.notes, index: i };
    }
    return null;
  }

  const api: NotesApi = {
    notes: [], // consumed via snapshot, not this field
    add: (n) => {
      const targetBundle =
        n.scope === "personal" && personal ? personal : group;
      const id = localId();
      const m = new Y.Map();
      m.set("id", id);
      m.set("scope", n.scope);
      const body = new Y.Text();
      if (n.body) body.insert(0, n.body);
      m.set("body", body);
      if (n.verse_anchor) m.set("verse_anchor", n.verse_anchor);
      if (n.by_agent) m.set("by_agent", n.by_agent);
      targetBundle.notes.push([m]);
      // Register group notes with the server so social endpoints
      // (likes / comments) can reject any note_id that wasn't
      // actually added to the shared doc. Personal notes never
      // touch this — registering them would be a privacy violation.
      if (n.scope === "group" && !n.by_agent) {
        void serverApi.noteRegisterGroup(roomId, id).catch(() => {
          // Quiet on failure: the worst case is that hearts/comments
          // briefly 404 until the next register attempt. We don't
          // want to roll back the Yjs add.
        });
      }
      return id;
    },
    update: (id, body) => {
      // Try personal first since personal notes are typically the more
      // common edit target for the signed-in user.
      const bundles: DocBundle[] = personal ? [personal, group] : [group];
      for (const bundle of bundles) {
        const found = findInDoc(bundle, id);
        if (!found) continue;
        bundle.doc.transact(() => {
          const m = found.arr.get(found.index) as Y.Map<unknown>;
          const existing = m.get("body");
          if (existing instanceof Y.Text) {
            applyDiffToYText(existing, body);
          } else {
            const yt = new Y.Text();
            if (body) yt.insert(0, body);
            m.set("body", yt);
          }
        });
        return;
      }
    },
    remove: (id) => {
      const bundles: DocBundle[] = personal ? [personal, group] : [group];
      for (const bundle of bundles) {
        const found = findInDoc(bundle, id);
        if (!found) continue;
        bundle.doc.transact(() => {
          found.arr.delete(found.index, 1);
        });
        return;
      }
    },
    forVerse: () => [],
    forChapter: () => [],
  };

  return {
    group,
    personal,
    api,
    cleanup: () => {
      try {
        groupProvider.destroy();
      } catch {}
      try {
        groupPersistence.destroy();
      } catch {}
      try {
        groupDoc.destroy();
      } catch {}
      if (personal) {
        try {
          personal.provider.destroy();
        } catch {}
        try {
          personal.persistence.destroy();
        } catch {}
        try {
          personal.doc.destroy();
        } catch {}
      }
    },
  };
}
