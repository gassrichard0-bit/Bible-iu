/**
 * Web Push subscribe/unsubscribe (chat + group notes wake the phone).
 *
 * iOS Safari delivers push only when the PWA is installed to Home
 * Screen — until then the OS treats `Notification.requestPermission()`
 * as denied. We surface that as the literal status "needs-install"
 * so Settings can prompt the user to install before re-trying.
 *
 * The VAPID public key is fetched from the backend at subscribe time
 * (not bundled) so rotating the keypair doesn't require a redeploy.
 */
import { getPassword, getSessionToken } from "./api";

const SUBSCRIBED_KEY = "bible-iu:push-subscribed";
// Set once we've made the auto-enable attempt — success OR failure
// (denied permission, unsupported, errored). Keeps us from re-prompting
// every login. The user can still flip it on later via Settings.
const AUTO_TRIED_KEY = "bible-iu:push-auto-tried";

export type PushStatus =
  | "unsupported"      // No service worker / PushManager / Notification
  | "needs-install"    // iOS Safari before the user added to Home Screen
  | "permission-denied"
  | "subscribed"
  | "not-subscribed";

function urlBase64ToUint8Array(b64: string): Uint8Array {
  // Browsers want a Uint8Array of the raw EC point bytes. Backend
  // gives us URL-safe base64 (no padding); pad + un-URL-safe + decode.
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const standard = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(standard);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getPushStatus(): Promise<PushStatus> {
  if (typeof window === "undefined") return "unsupported";
  // Cast through `unknown` once: TS narrows `window` to `never` after
  // the `typeof === "undefined"` guard above, which makes property
  // access on it fail at compile time. The runtime value is a Window.
  const w = window as unknown as Window;
  if (!("serviceWorker" in navigator)) return "unsupported";
  const hasPush = "PushManager" in w;
  const hasNotif = "Notification" in w;
  if (!hasPush || !hasNotif) {
    // iOS Safari only exposes PushManager when running standalone
    // (PWA installed). Outside that, both checks fail.
    const nav = w.navigator as Navigator & { standalone?: boolean };
    const standalone =
      nav.standalone === true ||
      (typeof w.matchMedia === "function"
        ? w.matchMedia("(display-mode: standalone)").matches
        : false);
    return standalone ? "unsupported" : "needs-install";
  }
  if (Notification.permission === "denied") return "permission-denied";
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "not-subscribed";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "not-subscribed";
}

/** Best-effort: ask permission, subscribe, register with backend. Safe
 *  to call multiple times — the backend upserts on endpoint. */
export async function subscribeToPush(): Promise<PushStatus> {
  const status = await getPushStatus();
  if (status === "unsupported" || status === "needs-install") return status;

  const perm =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  if (perm !== "granted") return "permission-denied";

  // Without an active SW there's nothing to receive the push. The
  // shell registers /sw.js at app boot, but if the user opened the
  // tab before that ran (or registration is still in flight) `ready`
  // can hang — cap at 10s and surface a clean error.
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<ServiceWorkerRegistration>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Service worker isn't ready yet. Reload the page and try again.",
            ),
          ),
        10000,
      ),
    ),
  ]);
  if (!reg.pushManager) return "unsupported";

  // Fetch VAPID key fresh — rotating keys server-side shouldn't
  // require a rebuild. Backend returns { public_key: string | null }.
  const keyRes = await fetch(`/api/push/vapid-key`, {
    headers: {
      "X-App-Password": getPassword(),
      "X-Session-Token": getSessionToken(),
    },
  });
  if (!keyRes.ok) throw new Error(`vapid-key fetch failed: ${keyRes.status}`);
  const { public_key } = (await keyRes.json()) as { public_key: string | null };
  if (!public_key) throw new Error("Server has no VAPID key configured.");

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const keyBytes = urlBase64ToUint8Array(public_key);
    // TS lib.dom currently types BufferSource without Uint8Array<ArrayBufferLike>
    // — cast for the subscribe call, which accepts the raw bytes at runtime.
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes as unknown as BufferSource,
    });
  }

  const subJson = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  const endpoint = subJson.endpoint || sub.endpoint;
  const p256dh =
    subJson.keys?.p256dh || arrayBufferToBase64Url(sub.getKey("p256dh"));
  const auth =
    subJson.keys?.auth || arrayBufferToBase64Url(sub.getKey("auth"));

  const r = await fetch(`/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": getPassword(),
      "X-Session-Token": getSessionToken(),
    },
    body: JSON.stringify({ endpoint, p256dh, auth }),
  });
  if (!r.ok) throw new Error(`subscribe failed: ${r.status}`);
  try {
    localStorage.setItem(SUBSCRIBED_KEY, "1");
  } catch {
    // best-effort
  }
  return "subscribed";
}

export async function unsubscribeFromPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch {
    // best-effort — even if the browser side fails, drop the row
    // server-side so future sends skip this device.
  }
  await fetch(`/api/push/unsubscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": getPassword(),
      "X-Session-Token": getSessionToken(),
    },
    body: JSON.stringify({ endpoint }),
  });
  try {
    localStorage.removeItem(SUBSCRIBED_KEY);
  } catch {
    // best-effort
  }
}

/** Auto-resubscribe on app load when the user has previously opted in.
 *  No-op in dev (no SW), no-op if permission was revoked, no-op if
 *  the user has never tapped the Settings toggle. */
export async function refreshPushSubscriptionIfOptedIn(): Promise<void> {
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(SUBSCRIBED_KEY) !== "1") return;
    if (Notification?.permission !== "granted") return;
    await subscribeToPush();
  } catch {
    // best-effort; permanent failures are visible in the Settings UI
  }
}

/** Default-on opt-in: try to subscribe automatically the first time
 *  this device sees a signed-in user, so new accounts get push without
 *  having to dig through Settings. Must be called from inside a user
 *  gesture (e.g. right after the login button submit) — iOS Safari
 *  silently refuses `Notification.requestPermission()` otherwise.
 *
 *  We record `auto-tried` either way so the prompt only ever fires
 *  once per device. After that, Settings → Notifications is the only
 *  path to flip it. Returns the final status for the caller to log. */
export async function maybeAutoEnablePush(): Promise<PushStatus | "skipped"> {
  try {
    if (typeof localStorage === "undefined") return "skipped";
    if (localStorage.getItem(AUTO_TRIED_KEY) === "1") return "skipped";
    // Don't pop a permission prompt on iOS Safari outside a PWA — it
    // just denies silently and we'd burn the one-shot.
    const status = await getPushStatus();
    if (status === "unsupported" || status === "needs-install") {
      localStorage.setItem(AUTO_TRIED_KEY, "1");
      return status;
    }
    if (status === "subscribed") {
      // Already on (older session migrated in) — nothing to do.
      localStorage.setItem(AUTO_TRIED_KEY, "1");
      return status;
    }
    const final = await subscribeToPush();
    localStorage.setItem(AUTO_TRIED_KEY, "1");
    return final;
  } catch {
    try {
      localStorage.setItem(AUTO_TRIED_KEY, "1");
    } catch {
      // best-effort
    }
    return "skipped";
  }
}
