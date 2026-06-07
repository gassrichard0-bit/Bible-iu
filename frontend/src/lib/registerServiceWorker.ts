/**
 * Register the service worker. We register in dev too — Web Push
 * needs an active SW or `navigator.serviceWorker.ready` never
 * resolves. The SW itself short-circuits its install + fetch handlers
 * when running under Vite's dev port so HMR isn't broken; only its
 * push + notificationclick handlers stay live there.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[sw] registration failed", err);
      });
  });
}
