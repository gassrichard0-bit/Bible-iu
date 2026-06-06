/**
 * Share-room modal — generate and manage invite links for a room.
 *
 * Anyone with the link who has a Bible IU account (and the deployment
 * password) can join. Links default to 7-day expiry; can be revoked
 * instantly. The room name comes from the live API, not props, so
 * stale prop values don't leak into the share text.
 */
import { useEffect, useState } from "react";
import { api, type InviteOut } from "../lib/api";
import { BottomSheet } from "./BottomSheet";

interface Props {
  open: boolean;
  onClose: () => void;
  roomId: string;
  roomName: string;
}

export function ShareRoomModal({ open, onClose, roomId, roomName }: Props) {
  const [invites, setInvites] = useState<InviteOut[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCopiedCode(null);
    void refresh();
  }, [open, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    try {
      const list = await api.listInvites(roomId);
      setInvites(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createInvite() {
    setCreating(true);
    setError(null);
    try {
      // 7-day expiry, capped at 10 joins per link. Keeps a leaked link
      // from going viral; mint another if you need more.
      await api.createInvite(roomId, 7, 10);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(code: string) {
    if (!confirm("Revoke this invite link?")) return;
    try {
      await api.revokeInvite(code);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function urlFor(code: string): string {
    if (typeof window === "undefined") return `/?invite=${code}`;
    return `${window.location.origin}/?invite=${code}`;
  }

  async function copy(code: string) {
    const url = urlFor(code);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1500);
    } catch {
      // Some browsers gate clipboard behind permissions/secure-context.
      // Fall back to select-on-click: leave the input selected so user
      // can ⌘C / Ctrl-C themselves.
      const input = document.getElementById(
        `invite-url-${code}`,
      ) as HTMLInputElement | null;
      input?.select();
    }
  }

  if (!open) return null;

  const active = (invites ?? []).filter((i) => !i.revoked && isStillValid(i));
  const stale = (invites ?? []).filter((i) => i.revoked || !isStillValid(i));

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`Share "${roomName}"`}
      desktopMaxWidth="lg"
    >
        <div className="px-4 py-3">
          <p className="mb-3 text-xs text-neutral-600 dark:text-neutral-300">
            Anyone with a Bible IU account who opens an active link below
            joins this room. Each link allows up to 10 joins and expires
            after 7 days; revoke any time.
          </p>

          {error && (
            <p className="mb-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          )}

          {invites === null ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Loading…
            </p>
          ) : (
            <>
              {active.length === 0 && (
                <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                  No active invites. Create one below.
                </p>
              )}
              {active.map((inv) => (
                <InviteRow
                  key={inv.code}
                  inv={inv}
                  url={urlFor(inv.code)}
                  copied={copiedCode === inv.code}
                  onCopy={() => copy(inv.code)}
                  onRevoke={() => revoke(inv.code)}
                />
              ))}
              {stale.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
                    Previous links ({stale.length})
                  </summary>
                  <ul className="mt-1 space-y-1 pl-3 text-[11px] text-neutral-500 dark:text-neutral-400">
                    {stale.map((inv) => (
                      <li key={inv.code} className="font-mono">
                        {inv.code.slice(0, 8)}…{" "}
                        <span className="text-neutral-400 dark:text-neutral-500">
                          ({inv.revoked ? "revoked" : "expired"}, used {inv.uses}×)
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          <div className="mt-4 flex justify-end">
            <button
              onClick={createInvite}
              disabled={creating}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-2xl bg-neutral-900 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {creating ? "Creating…" : "+ New invite link"}
            </button>
          </div>
        </div>
    </BottomSheet>
  );
}

function InviteRow({
  inv,
  url,
  copied,
  onCopy,
  onRevoke,
}: {
  inv: InviteOut;
  url: string;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  return (
    <div className="mb-2 rounded-2xl border border-neutral-200 bg-paper px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex items-center gap-2">
        <input
          id={`invite-url-${inv.code}`}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-paper-soft px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
        />
        <button
          onClick={onCopy}
          className="shrink-0 rounded-full border border-neutral-300 bg-paper px-3 py-1.5 text-[12px] font-semibold hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
        <button
          onClick={onRevoke}
          className="shrink-0 rounded-full border border-red-300 bg-paper px-3 py-1.5 text-[12px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-neutral-900 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          Revoke
        </button>
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-neutral-500 dark:text-neutral-400">
        <span>Used {inv.uses}×</span>
        {inv.expires_at && (
          <span>Expires {new Date(inv.expires_at).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}

function isStillValid(inv: InviteOut): boolean {
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return false;
  return true;
}
