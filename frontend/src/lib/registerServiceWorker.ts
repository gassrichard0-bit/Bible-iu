/**
 * Register the service worker + watch for updates.
 *
 * We register in dev too — Web Push needs an active SW or
 * `navigator.serviceWorker.ready` never resolves. The SW itself
 * short-circuits its install + fetch handlers when running under
 * Vite's dev port so HMR isn't broken; only its push +
 * notificationclick handlers stay live there.
 *
 * The exported `SW_UPDATE_EVENT` fires on `window` when a new SW
 * has finished installing and is sitting in the `waiting` state.
 * A UI banner subscribes to this and offers the user a one-tap
 * reload. Without that prompt users would stay on a stale build
 * indefinitely (browser SW updates honor `skipWaiting` only after
 * every tab navigates away).
 */
export const SW_UPDATE_EVENT = "bible-iu:sw-update-ready";

function notifyUpdate(reg: ServiceWorkerRegistration): void {
  // Stash the waiting worker on `window` so the banner can call
  // `skipWaiting` without re-resolving the registration.
  (window as unknown as { __biSwWaiting?: ServiceWorker }).__biSwWaiting =
    reg.waiting ?? undefined;
  window.dispatchEvent(new Event(SW_UPDATE_EVENT));
}

export function activateWaitingServiceWorker(): void {
  const waiting = (window as unknown as { __biSwWaiting?: ServiceWorker })
    .__biSwWaiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  // `skipWaiting` makes the new worker take control. Reload once
  // it does — `controllerchange` fires after the activation.
  waiting.postMessage({ type: "SKIP_WAITING" });
}

export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        // Already-waiting worker from a prior visit.
        if (reg.waiting) notifyUpdate(reg);
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // There IS an active controller AND a new worker is
              // installed = update available. (Without an active
              // controller this is the first install, not an update.)
              notifyUpdate(reg);
            }
          });
        });
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[sw] registration failed", err);
      });
    // Reload after the new worker takes control.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}
