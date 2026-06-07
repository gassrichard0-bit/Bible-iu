/**
 * Minimal "stale-while-revalidate" service worker for the SPA shell.
 *
 * Caches the index.html + Vite-hashed assets so the next launch starts
 * instantly and offline shows the cached shell. API + WebSocket traffic
 * is NEVER cached — those go straight to the network so notes, sync,
 * and auth always reflect the latest state.
 *
 * Cache key is bumped on every release to evict the old shell. When
 * we add a real build pipeline we'll inject the bundle hash here.
 */
const CACHE = "bible-iu-shell-v2";
const PRECACHE = ["/", "/manifest.webmanifest"];

// True when this SW is running under Vite's dev server. We register
// the SW in dev so Web Push works locally, but skip the install
// precache + the fetch handler — otherwise HMR breaks because we'd
// intercept `/@vite/`, `/src/...`, and JSX module requests.
const IS_DEV = self.location.port === "5173";

self.addEventListener("install", (event) => {
  if (!IS_DEV) {
    event.waitUntil(
      caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)),
    );
  }
  // Apply the new SW as soon as the old one's tabs close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (IS_DEV) return;
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Pass-through: API, WebSocket, anything non-same-origin.
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/auth") ||
    url.pathname.startsWith("/rooms") ||
    url.pathname.startsWith("/reason") ||
    url.pathname.startsWith("/bible") ||
    url.pathname.startsWith("/healthz") ||
    url.pathname.startsWith("/ws")
  ) {
    return; // browser handles directly
  }

  // SPA shell + assets: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const fetchPromise = fetch(event.request)
        .then((response) => {
          // Only cache successful, basic responses to avoid poisoning
          // the cache with 404s or opaque redirects.
          if (response.ok && response.type === "basic") {
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => cached); // offline → fall back to cache
      return cached || fetchPromise;
    }),
  );
});

// Web Push — phone wake-up for chat + group notes. Payload shape comes
// from backend/api/push.py (fanout_to_room): { kind, room_id,
// room_name, sender, body, url }. iOS Safari delivers these only when
// the PWA is installed to Home Screen — until then the OS marks the
// app's notification permission as denied and the subscribe call fails.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.room_name
    ? `${data.sender || "Someone"} · ${data.room_name}`
    : (data.sender || "Bible IU");
  const opts = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Tag by room so multiple unread messages collapse into one
    // banner instead of stacking up on the lock screen.
    tag: data.room_id ? `room:${data.room_id}` : "bible-iu",
    renotify: true,
    data: { url: data.url || "/", room_id: data.room_id || null },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing tab if one is already open; otherwise
        // open a fresh window at the room.
        for (const c of clientList) {
          if ("focus" in c) {
            try {
              c.postMessage({ type: "notification-click", url: targetUrl });
            } catch (_) {}
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        return null;
      }),
  );
});
