/**
 * Shared hook for the live translation registry.
 *
 * Backend `GET /bible/translations` returns every translation row in
 * the registry — public-domain locals + licensed remotes — so the
 * BibleView / Settings / Profile pickers can render the dropdown
 * without a frontend rebuild every time a new translation is seeded.
 *
 * Caches the response at module scope so the first picker to mount
 * pays the round-trip and the rest are instant. The cache is cleared
 * on a hard reload (page reload / SW activation), which is the right
 * time to re-pull anyway.
 */
import { useEffect, useState } from "react";
import { api, type TranslationOption } from "./api";

let cached: TranslationOption[] | null = null;
let cachedAt = 0;
let inFlight: Promise<TranslationOption[]> | null = null;

// Short TTL — covers a single visit to the Bible page but stale-checks
// when the user returns later or when the registry changes. 60s is
// short enough that flipping a backend flag shows up within a minute,
// long enough to dedupe several picker mounts in one session.
const TTL_MS = 60_000;

async function load(force = false): Promise<TranslationOption[]> {
  if (!force && cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = api
    .bibleTranslations()
    .then((rows) => {
      cached = rows;
      cachedAt = Date.now();
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useTranslations(): TranslationOption[] {
  const [rows, setRows] = useState<TranslationOption[]>(cached ?? []);
  useEffect(() => {
    let cancelled = false;
    function refresh(force = false) {
      void load(force).then((r) => {
        if (!cancelled) setRows(r);
      });
    }
    // Initial fetch (uses cache if fresh).
    refresh(false);
    // Re-fetch when the tab regains focus / visibility — picks up any
    // backend enable/disable since the user was last looking. Force a
    // bypass of the in-memory cache so a long-idle tab doesn't keep
    // showing stale state.
    function onVisible() {
      if (document.visibilityState === "visible") refresh(true);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return rows;
}

/** A tiny fallback list used until the registry loads, so the picker
 *  isn't empty during the first paint. Subset of what the seed always
 *  guarantees is available. */
export const FALLBACK_TRANSLATIONS: TranslationOption[] = [
  {
    name: "King James Version",
    attribution: "Public Domain (King James Version, 1611)",
    source: "local",
    enabled: true,
  },
];
