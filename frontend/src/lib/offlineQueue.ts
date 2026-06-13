/**
 * Offline write queue for personal-data mutations.
 *
 * When the network fails for a mutating request (PUT/POST/DELETE),
 * the operation is stored in IndexedDB and replayed once the device
 * reconnects. Together with the optimistic SW-cache patches in
 * `api.ts`, this gives the user a "writes never lose" experience —
 * tap highlight while offline, the annotation appears immediately,
 * and it lands on the server the next time the Mac is reachable.
 *
 * Only mutating personal-data endpoints (`/auth/annotations/...`,
 * `/auth/bookmarks/...`) flow through here today. Group features
 * (chat, group notes) still need the server live — they get their
 * own offline handling via Yjs IndexedDB persistence (phase 3).
 */

interface QueuedOp {
  id: string;
  method: string;
  /** Path without `/api` prefix — matches the shape jsonFetch uses. */
  path: string;
  body?: string;
  /** Captured at enqueue time so the replay carries the same auth
   *  token / app password the user had when the write was queued. */
  headers: Record<string, string>;
  ts: number;
}

const DB_NAME = "bible-iu-offline";
const STORE = "pending-ops";
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueOp(
  op: Omit<QueuedOp, "id" | "ts">,
): Promise<string> {
  const id = crypto.randomUUID();
  const full: QueuedOp = { ...op, id, ts: Date.now() };
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(full);
    tx.oncomplete = () => {
      try {
        window.dispatchEvent(new CustomEvent("offline-queue:changed"));
      } catch {
        // ignore
      }
      res(id);
    };
    tx.onerror = () => rej(tx.error);
  });
}

async function listOps(): Promise<QueuedOp[]> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () =>
      res((req.result as QueuedOp[]).sort((a, b) => a.ts - b.ts));
    req.onerror = () => rej(req.error);
  });
}

async function removeOp(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function pendingCount(): Promise<number> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

let draining = false;

/**
 * Replay the queued ops sequentially. Sequential matters because
 * (verse_id, kind) idempotency means a later DELETE depends on the
 * earlier PUT having landed first.
 *
 * Stop draining on the first non-2xx that isn't a 404 — leaving the
 * op in the queue is safer than dropping it and discovering on the
 * next online refresh that the write never made it.
 */
export async function drainQueue(): Promise<{
  drained: number;
  remaining: number;
}> {
  if (draining) return { drained: 0, remaining: await pendingCount() };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { drained: 0, remaining: await pendingCount() };
  }
  draining = true;
  let drained = 0;
  try {
    const ops = await listOps();
    for (const op of ops) {
      try {
        const apiBase =
          (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
        const r = await fetch(`${apiBase}/api${op.path}`, {
          method: op.method,
          headers: op.headers,
          body: op.body,
        });
        // 2xx → success. 404 on DELETE → server already gone, treat
        // as success. 4xx other than 404 → permanent failure, drop
        // it so the queue doesn't get stuck.
        if (r.ok || r.status === 404 || (r.status >= 400 && r.status < 500)) {
          await removeOp(op.id);
          drained += 1;
        } else {
          // 5xx — server problem, keep the op for next drain.
          break;
        }
      } catch {
        // Network died mid-drain. Stop; we'll try again on next
        // "online" event.
        break;
      }
    }
  } finally {
    draining = false;
    try {
      window.dispatchEvent(new CustomEvent("offline-queue:changed"));
    } catch {
      // ignore
    }
  }
  return { drained, remaining: await pendingCount() };
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void drainQueue();
  });
  // Best-effort drain on app start in case a prior session enqueued
  // ops the user never came back to drain. 1500ms delay lets the
  // initial auth + chapter-load pass first.
  if (navigator.onLine) {
    setTimeout(() => {
      void drainQueue();
    }, 1500);
  }
}
