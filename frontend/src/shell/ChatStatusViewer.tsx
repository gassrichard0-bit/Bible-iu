/**
 * Full-screen status viewer (WhatsApp-style stories). Plays one
 * author's statuses end-to-end: 6s per slide, progress bar at the
 * top with one segment per status, tap left/right edges to step
 * back/forward, swipe down (Esc) to dismiss. Marks each viewed
 * status against the server on advance so the owner's view count
 * + the strip's "seen" ring stay accurate.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StatusOut } from "../lib/api";
import { API_BASE, getPassword, getSessionToken } from "../lib/api";
import { Avatar } from "./Profile";

/** Local copy of the auth-cred-injecting URL helper used by avatars.
 *  We can't reuse the one from Profile.tsx (it isn't exported) and
 *  duplicating it is cheaper than a refactor right now. */
function withApiPrefix(path: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  let apiPath = path;
  if (!apiPath.startsWith("/api")) {
    if (apiPath.startsWith("/")) apiPath = `/api${apiPath}`;
    else return path;
  }
  const base = `${API_BASE}${apiPath}`;
  const sep = base.includes("?") ? "&" : "?";
  const auth: string[] = [];
  const pw = getPassword();
  const tok = getSessionToken();
  if (pw) auth.push(`password=${encodeURIComponent(pw)}`);
  if (tok) auth.push(`session=${encodeURIComponent(tok)}`);
  return auth.length ? `${base}${sep}${auth.join("&")}` : base;
}

interface Props {
  open: boolean;
  statuses: StatusOut[];
  /** Index into `statuses` to start at. Default 0. */
  initialIndex?: number;
  /** Caller's user id — used to decide whether to render a delete
   *  button on the author's own statuses. */
  selfUserId: string | undefined;
  onClose: () => void;
  /** Called after a successful author-side delete so the parent can
   *  drop the row from its local list. */
  onDeleted?: (statusId: string) => void;
}

const SLIDE_MS = 6000;

export function ChatStatusViewer({
  open,
  statuses,
  initialIndex = 0,
  selfUserId,
  onClose,
  onDeleted,
}: Props) {
  const [idx, setIdx] = useState(initialIndex);
  // Tick at ~30fps to drive the progress bar smoothly.
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);

  const current = statuses[idx] ?? null;

  // Reset when (re)opened or when the source list changes underneath us.
  useEffect(() => {
    if (!open) return;
    setIdx(initialIndex);
    setProgress(0);
  }, [open, initialIndex, statuses]);

  // Drive the per-slide timer.
  useEffect(() => {
    if (!open || !current) return;
    startRef.current = performance.now();
    pausedRef.current = false;
    let pausedAt = 0;
    const step = (t: number) => {
      if (pausedRef.current) {
        pausedAt = t;
        rafRef.current = requestAnimationFrame(step);
        return;
      }
      if (pausedAt) {
        startRef.current += t - pausedAt;
        pausedAt = 0;
      }
      const p = Math.min(1, (t - startRef.current) / SLIDE_MS);
      setProgress(p);
      if (p >= 1) {
        // advance
        setIdx((i) => {
          if (i + 1 >= statuses.length) {
            onClose();
            return i;
          }
          return i + 1;
        });
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [open, idx, current, statuses.length, onClose]);

  // Mark current status viewed on the server (and locally) once the
  // slide has been on screen for >800ms — too snappy and a fast-skip
  // would mark everything seen by accident.
  useEffect(() => {
    if (!open || !current || current.author_user_id === selfUserId) return;
    if (current.viewer_has_viewed) return;
    const t = window.setTimeout(() => {
      void api
        .statusView(current.room_id, current.id)
        .catch(() => {});
    }, 800);
    return () => window.clearTimeout(t);
  }, [open, current, selfUserId]);

  // Keyboard: Escape closes, arrows step.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") stepForward();
      else if (e.key === "ArrowLeft") stepBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idx, statuses.length]);

  function stepForward() {
    setIdx((i) => {
      if (i + 1 >= statuses.length) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }
  function stepBack() {
    setIdx((i) => Math.max(0, i - 1));
  }

  async function deleteCurrent() {
    if (!current) return;
    if (!confirm("Delete this status?")) return;
    try {
      await api.statusDelete(current.room_id, current.id);
      onDeleted?.(current.id);
      // If this was the last one in the run, close. Otherwise the
      // parent's WS handler will drop the row and the effect above
      // resets idx.
      if (statuses.length <= 1) onClose();
    } catch (e) {
      alert(`Couldn't delete: ${(e as Error).message}`);
    }
  }

  const imageSrc = useMemo(
    () => (current?.image_url ? withApiPrefix(current.image_url) : null),
    [current],
  );

  if (!open || !current) return null;

  const isMine = current.author_user_id === selfUserId;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Status viewer"
    >
      {/* Progress bars + header */}
      <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2"
           style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}>
        <div className="flex items-center gap-1">
          {statuses.map((_, i) => (
            <div
              key={i}
              className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/30"
            >
              <div
                className="h-full bg-white"
                style={{
                  width: `${
                    i < idx ? 100 : i === idx ? Math.round(progress * 100) : 0
                  }%`,
                }}
              />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 pb-1">
          <Avatar
            handle={current.author_handle ?? "?"}
            url={current.author_avatar_url}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">
              {current.author_display_name ||
                current.author_handle ||
                "Member"}
            </div>
            <div className="text-[10px] text-white/70">
              {relativeTime(current.created_at)}
            </div>
          </div>
          {isMine && (
            <button
              type="button"
              onClick={() => void deleteCurrent()}
              className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/25"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body. Tap left third → back, tap right third → forward, middle
       *  reserved for future "pause on hold". */}
      <div
        className="relative flex flex-1 items-center justify-center"
        onPointerDown={() => (pausedRef.current = true)}
        onPointerUp={() => (pausedRef.current = false)}
        onPointerCancel={() => (pausedRef.current = false)}
      >
        {imageSrc && (
          <img
            src={imageSrc}
            alt="Status photo"
            className="max-h-full max-w-full object-contain"
          />
        )}
        {current.body && (
          <div
            className={`absolute inset-x-4 ${
              imageSrc ? "bottom-6" : "top-1/2 -translate-y-1/2"
            } rounded-2xl bg-black/50 px-4 py-3 text-center text-[18px] leading-snug backdrop-blur-md`}
          >
            {current.body}
          </div>
        )}
        {/* Edge tap zones (transparent). */}
        <button
          type="button"
          aria-label="Previous"
          className="absolute inset-y-0 left-0 w-1/3 cursor-default"
          onClick={(e) => {
            e.stopPropagation();
            stepBack();
          }}
        />
        <button
          type="button"
          aria-label="Next"
          className="absolute inset-y-0 right-0 w-1/3 cursor-default"
          onClick={(e) => {
            e.stopPropagation();
            stepForward();
          }}
        />
      </div>

      {/* Footer: view count for author. */}
      {isMine && (
        <div
          className="shrink-0 px-4 py-3 text-[12px] text-white/80"
          style={{
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
          }}
        >
          <span aria-hidden>👁</span>{" "}
          {current.view_count}{" "}
          {current.view_count === 1 ? "view" : "views"}
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.floor((now - d) / 1000));
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return "Yesterday";
}
