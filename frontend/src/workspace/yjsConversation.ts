/**
 * Per-user, per-room conversation persistence via Yjs.
 *
 * Scope: each user's conversation in a given room lives in its own
 * Y.Doc at `/ws/yjs/conv__{handle}__{roomId}`. Yjs handles syncing
 * across browser tabs and survives page refresh while the server's
 * Y.Doc is alive (server restart still loses state until y-store
 * persistence lands — `TODO(spec)` for offline-first per
 * `CLAUDE.md` §8).
 *
 * Why a separate doc and not the room's notes doc?
 *   - Conversations are personal — Paul's conversation with the agent
 *     shouldn't appear in Mary's pane (`rule-guide.MD` §13 isolation,
 *     applied here at the doc-id level).
 *   - Notes are shared room-scope, so they live in a different doc
 *     (still per-room).
 *
 * Limitation: `handle` is the localStorage stub from `Login.tsx`.
 * Anyone who knows another user's handle could connect to their doc.
 * When real auth lands (`CLAUDE.md` §4.11), the server should verify
 * the token matches the handle in the doc path before opening the
 * channel. Documented as TODO.
 */
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import type { ConversationTurn } from "./Workspace";
import { getPassword, getSessionToken } from "../lib/api";


function buildHandle(handle: string, roomId: string) {
  // No room/handle yet — return an unsynced doc so we don't open a
  // WebSocket. The URL `/ws/yjs/conv__anon__?…` would 403 on an
  // unmatched route and flood the console.
  if (!roomId || !handle) {
    const doc = new Y.Doc();
    const turns = doc.getArray<Y.Map<unknown>>("turns");
    return {
      doc,
      turns,
      cleanup: () => doc.destroy(),
    };
  }
  const doc = new Y.Doc();
  // Conversation turns live in a Y.Array of Y.Map. The Map's `response`
  // field is JSON-encoded so structured ReasoningResponse round-trips
  // cleanly through Yjs's primitive-only value types.
  const turns = doc.getArray<Y.Map<unknown>>("turns");

  // Sanitize handle so it can live in a URL path segment.
  const safeHandle = handle.replace(/[^A-Za-z0-9_-]/g, "_") || "anon";
  const docName = `conv__${safeHandle}__${roomId}`;

  // Local IndexedDB persistence — survives network drop + tab close.
  const persistence = new IndexeddbPersistence(docName, doc);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/yjs`;
  const provider = new WebsocketProvider(url, docName, doc, {
    params: {
      password: getPassword(),
      session: getSessionToken(),
    },
  });

  return {
    doc,
    turns,
    cleanup: () => {
      // Wait for IndexedDB to flush any pending writes before tearing
      // the doc down. Without this, a quick close-then-reopen (tab
      // switch, agent toggle, etc.) can truncate the last few
      // conversation updates and the agent appears to "forget" the
      // thread. `whenSynced` resolves once initial load + any pending
      // writes have settled.
      const flushAndDestroy = async () => {
        try {
          await persistence.whenSynced;
        } catch {
          // ignore — best-effort flush
        }
        try {
          provider.destroy();
        } catch {}
        try {
          persistence.destroy();
        } catch {}
        try {
          doc.destroy();
        } catch {}
      };
      void flushAndDestroy();
    },
  };
}


function snapshot(turns: Y.Array<Y.Map<unknown>>): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const m = turns.get(i) as Y.Map<unknown>;
    const responseRaw = m.get("response");
    let response = null;
    if (typeof responseRaw === "string" && responseRaw) {
      try {
        response = JSON.parse(responseRaw);
      } catch {
        response = null;
      }
    }
    const stagesRaw = m.get("stages");
    let stages: ConversationTurn["stages"] = [];
    if (typeof stagesRaw === "string" && stagesRaw) {
      try {
        stages = JSON.parse(stagesRaw);
      } catch {
        stages = [];
      }
    }
    out.push({
      id: (m.get("id") as string) ?? `t-${i}`,
      question: (m.get("question") as string) ?? "",
      verse_ref: (m.get("verse_ref") as string) ?? "",
      scope_label: (m.get("scope_label") as string) || undefined,
      scope_kind:
        (m.get("scope_kind") as ConversationTurn["scope_kind"]) || undefined,
      reasoning: (m.get("reasoning") as string) ?? "",
      rawCot: (m.get("rawCot") as string) ?? "",
      stages,
      response,
      pending: !!m.get("pending"),
      error: (m.get("error") as string) || undefined,
    });
  }
  return out;
}


export interface ConversationApi {
  turns: ConversationTurn[];
  /** Append a new turn (typically pending). Returns the turn id. */
  add: (t: ConversationTurn) => string;
  /** Mutate fields on an existing turn by id. Yjs handles CRDT merge. */
  update: (id: string, patch: Partial<ConversationTurn>) => void;
  /** Wipe every turn — used by the `/new` slash command. The Yjs
   *  delete is broadcast to other tabs/devices syncing the same
   *  conversation doc, so the reset is consistent everywhere. */
  clear: () => void;
}


export function useYjsConversation(
  handle: string,
  roomId: string,
): ConversationApi {
  const ref = useMemo(() => buildHandle(handle, roomId), [handle, roomId]);
  useEffect(() => () => ref.cleanup(), [ref]);

  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    ref.turns.observeDeep(fn);
    return () => ref.turns.unobserveDeep(fn);
  }, [ref]);

  const turns = snapshot(ref.turns);

  return {
    turns,
    add: (t) => {
      const m = new Y.Map<unknown>();
      m.set("id", t.id);
      m.set("question", t.question);
      m.set("verse_ref", t.verse_ref);
      if (t.scope_label) m.set("scope_label", t.scope_label);
      if (t.scope_kind) m.set("scope_kind", t.scope_kind);
      m.set("reasoning", t.reasoning);
      m.set("rawCot", t.rawCot);
      m.set("stages", JSON.stringify(t.stages ?? []));
      m.set("pending", !!t.pending);
      if (t.response) m.set("response", JSON.stringify(t.response));
      if (t.error) m.set("error", t.error);
      ref.turns.push([m]);
      return t.id;
    },
    update: (id, patch) => {
      ref.doc.transact(() => {
        for (let i = 0; i < ref.turns.length; i++) {
          const m = ref.turns.get(i) as Y.Map<unknown>;
          if (m.get("id") !== id) continue;
          if (patch.question !== undefined) m.set("question", patch.question);
          if (patch.reasoning !== undefined) m.set("reasoning", patch.reasoning);
          if (patch.rawCot !== undefined) m.set("rawCot", patch.rawCot);
          if (patch.stages !== undefined) {
            m.set("stages", JSON.stringify(patch.stages));
          }
          if (patch.pending !== undefined) m.set("pending", patch.pending);
          if (patch.response !== undefined) {
            m.set(
              "response",
              patch.response ? JSON.stringify(patch.response) : "",
            );
          }
          if (patch.error !== undefined) m.set("error", patch.error || "");
          return;
        }
      });
    },
    clear: () => {
      ref.doc.transact(() => {
        if (ref.turns.length > 0) ref.turns.delete(0, ref.turns.length);
      });
    },
  };
}
