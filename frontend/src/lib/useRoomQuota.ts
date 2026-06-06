/**
 * Polls the per-room, per-user daily quota for the agent. Returns the
 * latest snapshot plus a `refresh()` hook so callers can re-fetch
 * right after a successful /reason turn (the backend increments the
 * counter inside that call, so the UI hint goes stale otherwise).
 *
 * The backend store is in-memory single-instance — the hook is
 * best-effort. We silently swallow errors so a quota outage never
 * blocks the composer.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type QuotaStatus } from "./api";

export function useRoomQuota(roomId: string | null | undefined) {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    try {
      const next = await api.roomQuota(roomId);
      setQuota(next);
    } catch {
      // Best-effort hint; stay quiet on failure.
    }
  }, [roomId]);

  useEffect(() => {
    setQuota(null);
    void refresh();
  }, [roomId, refresh]);

  return { quota, refresh };
}
