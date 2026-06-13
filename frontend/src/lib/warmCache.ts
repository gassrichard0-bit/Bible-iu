/**
 * Pre-warm the offline cache so the next offline launch isn't empty.
 *
 * The service worker caches read endpoints on first hit. That's fine
 * if the user actually visited Marks, Notes, the translation picker,
 * etc. while online. But if they only ever opened the Bible reader
 * online and then take the phone offline a week later, every other
 * page renders empty.
 *
 * This helper hits the read-only endpoints in the background after
 * sign-in so the SW cache is hydrated regardless of what UI paths
 * the user actually clicked. It runs once per session, only when
 * online, and never blocks the UI — failures are silent (they'll
 * succeed on the next online launch).
 */

import { API_BASE, getPassword, getSessionToken } from "./api";

const WARMED_KEY = "bible-iu:cache-warmed-at";
const WARM_TTL_MS = 60 * 60 * 1000; // 1 hour

const BASE_PATHS = [
  "/bible/books",
  "/bible/translations",
  "/auth/me",
  "/auth/bookmarks",
  "/auth/annotations",
  "/notes/all?limit=200",
  "/rooms",
  "/reading-plans",
];

interface RoomRow {
  id: string;
}

export async function warmOfflineCache(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  // Skip if the user isn't signed in yet — these endpoints all 401
  // without a token, which would poison the cache with 401 responses.
  if (!getSessionToken()) return;
  const last = Number(localStorage.getItem(WARMED_KEY) || 0);
  if (Number.isFinite(last) && Date.now() - last < WARM_TTL_MS) return;

  const headers = {
    "X-App-Password": getPassword(),
    "X-Session-Token": getSessionToken(),
  };

  // Phase 1: base endpoints in parallel. Once /rooms lands we can
  // fan out into per-room chat backfills.
  await Promise.allSettled(
    BASE_PATHS.map((p) =>
      fetch(`${API_BASE}/api${p}`, { headers }).catch(() => null),
    ),
  );

  // Phase 2: per-room recent chat. Keep the request count tame —
  // even users with 30 rooms only fire 30 parallel GETs, all of
  // which short-circuit through the SW cache after the first warm.
  try {
    const roomsResp = await fetch(`${API_BASE}/api/rooms`, { headers });
    if (roomsResp.ok) {
      const rooms = (await roomsResp.json()) as RoomRow[];
      await Promise.allSettled(
        rooms.map((r) =>
          fetch(`${API_BASE}/api/rooms/${r.id}/chat?limit=50`, {
            headers,
          }).catch(() => null),
        ),
      );
    }
  } catch {
    // Room enumeration failed (likely the network just dropped) —
    // base endpoints already cached, so this miss is fine.
  }

  try {
    localStorage.setItem(WARMED_KEY, String(Date.now()));
  } catch {
    // localStorage full / disabled — fine, just means we re-warm next
    // session.
  }
}
