/**
 * Subtle status pill that surfaces online/offline state and any
 * outstanding personal-data writes that are waiting to sync.
 *
 *   • Online + 0 queued → renders nothing (no UI noise).
 *   • Online + N queued → "Syncing N…" while the queue drains, then
 *     disappears.
 *   • Offline + 0 queued → "Offline" (so the user knows the absence
 *     of pending markers isn't a sync claim).
 *   • Offline + N queued → "Offline · N pending".
 *
 * Mounted once at the shell level. Positioned absolutely so it never
 * shifts content. Tap-through; no actions today.
 */

import { useEffect, useState } from "react";
import { pendingCount } from "../lib/offlineQueue";

export function OfflineIndicator() {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const handleOn = () => setOnline(true);
    const handleOff = () => setOnline(false);
    window.addEventListener("online", handleOn);
    window.addEventListener("offline", handleOff);
    return () => {
      window.removeEventListener("online", handleOn);
      window.removeEventListener("offline", handleOff);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const n = await pendingCount();
        if (!cancelled) setPending(n);
      } catch {
        // pendingCount swallows its own errors; ignore here too.
      }
    };
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("offline-queue:changed", onChange);
    // Cheap belt-and-braces poll in case a future enqueue path skips
    // the event for any reason. 5s is invisible and costs nothing.
    const poll = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue:changed", onChange);
      window.clearInterval(poll);
    };
  }, []);

  let label: string | null = null;
  if (!online && pending > 0) label = `Offline · ${pending} pending`;
  else if (!online) label = "Offline";
  else if (pending > 0) label = `Syncing ${pending}…`;
  if (!label) return null;

  const isOffline = !online;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 6px)",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "inline-block",
          padding: "2px 10px",
          borderRadius: "9999px",
          fontSize: "11px",
          fontWeight: 500,
          letterSpacing: "0.02em",
          color: isOffline ? "#fff" : "#0d0d0d",
          background: isOffline
            ? "rgba(0, 0, 0, 0.65)"
            : "rgba(245, 200, 60, 0.92)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      >
        {label}
      </span>
    </div>
  );
}
