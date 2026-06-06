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
const CACHE = "bible-iu-shell-v1";
const PRECACHE = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
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
