/**
 * Profile preview surface for a user the viewer doesn't necessarily
 * know. Used by:
 *   - Tapping a sender's avatar in chat
 *   - Tapping a member row in AdminPanel (future)
 *
 * Shows the safe-to-broadcast subset of the user's profile (handle,
 * display name, photo, language hints) and a single primary CTA:
 * "Message". That CTA fires the parent-supplied `onMessage` which is
 * wired to `api.dmOpen(user_id)`.
 *
 * Opening this sheet does NOT open a DM. The user has to tap
 * Message — the previous "tap avatar = instant DM" was too eager.
 */
import { useEffect, useState } from "react";
import { api, type PublicUserView } from "../lib/api";
import { Avatar } from "./Profile";
import { BottomSheet } from "./BottomSheet";
import { ActionButton, Pill } from "./SettingsButtons";

interface Props {
  open: boolean;
  /** When set, the sheet fetches this user's public profile on open. */
  userId: string | null;
  /** Optional preview values used until /auth/users/{id} returns —
   *  carried straight off the chat message so the sheet doesn't
   *  flash a blank state. */
  preview?: {
    handle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
  };
  onClose: () => void;
  /** Fired when the user taps "Message". Parent opens (or finds) a
   *  1:1 DM with this user and switches to it. */
  onMessage: (userId: string) => void;
}

export function UserProfileSheet({
  open,
  userId,
  preview,
  onClose,
  onMessage,
}: Props) {
  const [profile, setProfile] = useState<PublicUserView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) {
      setProfile(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .userPublic(userId)
      .then((p) => alive && setProfile(p))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, userId]);

  // Use the live profile when we have it; otherwise fall back to the
  // preview pulled off the chat message (so the user sees the handle
  // + photo immediately).
  const handle =
    profile?.handle ?? preview?.handle ?? "";
  const displayName =
    profile?.display_name ?? preview?.displayName ?? handle ?? "User";
  const avatarUrl =
    profile?.avatar_url ?? preview?.avatarUrl ?? null;
  const languages = profile?.languages ?? [];

  return (
    <BottomSheet open={open} onClose={onClose} title="Profile">
      <div className="flex flex-col items-center gap-3 px-5 pb-6 pt-3">
        <div className="grid place-items-center rounded-full p-[2px] shadow-[0_4px_14px_rgba(0,0,0,0.18)]">
          <Avatar handle={handle || "?"} url={avatarUrl} size={96} />
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {displayName}
          </div>
          {handle && (
            <div className="font-mono text-[13px] text-neutral-500 dark:text-neutral-400">
              @{handle}
            </div>
          )}
        </div>
        {languages.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {languages.map((l) => (
              <span
                key={l}
                className="rounded-full border border-neutral-200 bg-paper px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              >
                {l}
              </span>
            ))}
          </div>
        )}
        {loading && (
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
            Loading…
          </span>
        )}
        {error && (
          <p
            role="alert"
            className="w-full rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-center text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}
        <div className="mt-3 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <ActionButton
            onClick={() => userId && onMessage(userId)}
            disabled={!userId}
          >
            💬 Message
          </ActionButton>
          <Pill onClick={onClose}>Close</Pill>
        </div>
      </div>
    </BottomSheet>
  );
}
