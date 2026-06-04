/**
 * Invite landing page — shown when the URL has `?invite=<code>`.
 *
 * Flow:
 *   1. preview the invite (works even signed-out; only the deployment
 *      password gate applies). Show room name + inviter.
 *   2. if signed-in → "Join" button → POST /invites/<code>/accept
 *   3. if signed-out → "Sign in to join" → returns to login, then
 *      re-renders here once signed in
 *
 * After joining we clear the `?invite=` query param and hand control
 * back to App, which renders the SocialShell with the new room
 * already in the user's list.
 */
import { useEffect, useState } from "react";
import { api, type InvitePreview } from "../lib/api";
import { GLASS_CARD } from "../lib/glass";

interface Props {
  code: string;
  signedIn: boolean;
  onJoined: (roomId: string) => void;
  onSignInNeeded: () => void;
  onCancel: () => void;
}

export function JoinRoom({
  code,
  signedIn,
  onJoined,
  onSignInNeeded,
  onCancel,
}: Props) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .previewInvite(code)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(formatErr((e as Error).message)));
    return () => {
      alive = false;
    };
  }, [code]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.acceptInvite(code);
      onJoined(r.id);
    } catch (e) {
      setError(formatErr((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-paper-soft dark:bg-neutral-950">
      <div className={`w-full max-w-sm p-5 ${GLASS_CARD}`}>
        <h1 className="mb-1 text-lg font-semibold">You&rsquo;ve been invited</h1>
        {error && (
          <p className="my-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {!preview && !error && (
          <p className="my-4 text-sm text-neutral-500 dark:text-neutral-400">
            Loading invite…
          </p>
        )}
        {preview && (
          <>
            <div className="mb-4 rounded border border-neutral-200 bg-paper-soft p-3 dark:border-neutral-800 dark:bg-neutral-950">
              <div className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Room
              </div>
              <div className="text-base font-medium">
                {preview.room_name || "(unnamed room)"}
              </div>
              <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                Invited by{" "}
                <span className="font-medium text-neutral-700 dark:text-neutral-200">
                  {preview.inviter_display_name}
                </span>{" "}
                <span className="font-mono">@{preview.inviter_handle}</span>
              </div>
              {preview.expires_at && (
                <div className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">
                  Link expires{" "}
                  {new Date(preview.expires_at).toLocaleString()}
                </div>
              )}
            </div>
            {!preview.can_join ? (
              <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                This link is no longer valid: {preview.reason}
              </p>
            ) : signedIn ? (
              <button
                onClick={join}
                disabled={busy}
                className="w-full rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {busy ? "Joining…" : "Join room"}
              </button>
            ) : (
              <button
                onClick={onSignInNeeded}
                className="w-full rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                Sign in to join
              </button>
            )}
          </>
        )}
        <button
          onClick={onCancel}
          className="mt-3 w-full rounded border border-neutral-300 px-3 py-1.5 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Skip — go to home
        </button>
      </div>
    </div>
  );
}

function formatErr(raw: string): string {
  const m = raw.match(/^\d{3}\s+\w+:?\s*(.*)$/);
  return m && m[1] ? m[1] : raw;
}
