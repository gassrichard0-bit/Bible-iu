/**
 * Offline-first local Bible reader.
 *
 * Public-domain English translations are shipped inside the iOS app
 * bundle (and served at `/bible-data/{slug}/{OSIS}.json` for the PWA
 * too) so the core Bible reader works without ever touching the
 * network. Each book is one JSON file matching the live
 * `/api/bible/.../multi` response shape, so the result drops into
 * BibleView with no reshaping at the call site.
 *
 * Bundled today: KJV, WEB, BSB, YLT, Darby. Licensed remotes
 * (NIV/NKJV) are NEVER bundled — they stay server-only.
 *
 * Dump script: `backend/data/dump_kjv_bundle.py`.
 */

import type {
  BibleChapterMulti,
  BibleSearchHit,
  BibleVerseMulti,
} from "./api";

interface BookFile {
  [chapter: string]: BibleVerseMulti[];
}

interface Manifest {
  translations: string[];
  /** Translation name → folder slug under /bible-data/. */
  translation_slugs: Record<string, string>;
  books: string[];
}

// translation+book → book payload, cached after first load.
const cache = new Map<string, BookFile>();
const inflight = new Map<string, Promise<BookFile | null>>();
let manifestPromise: Promise<Manifest | null> | null = null;

async function getManifest(): Promise<Manifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch("/bible-data/manifest.json")
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null);
  }
  return manifestPromise;
}

async function loadBook(
  slug: string,
  book: string,
): Promise<BookFile | null> {
  const key = `${slug}/${book}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const r = await fetch(`/bible-data/${slug}/${book}.json`);
        if (!r.ok) return null;
        const data = (await r.json()) as BookFile;
        cache.set(key, data);
        return data;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * Returns the chapter in BibleChapterMulti shape if every requested
 * translation is in the bundle. Returns null when:
 *   - any requested translation isn't bundled (NIV, NKJV, RST,
 *     Vulgata, etc.) — caller falls back to the network so all
 *     translations land at once
 *   - the book/chapter isn't in the bundle (manifest mismatch)
 *   - the bundle isn't reachable
 */
export async function getLocalChapter(
  book: string,
  chapter: number,
  translations: string[],
): Promise<BibleChapterMulti | null> {
  if (translations.length === 0) return null;
  const manifest = await getManifest();
  if (!manifest) return null;
  if (!manifest.books.includes(book)) return null;

  const slugs: { name: string; slug: string }[] = [];
  for (const t of translations) {
    const slug = manifest.translation_slugs[t];
    if (!slug) return null; // not bundled → caller hits network
    slugs.push({ name: t, slug });
  }

  // Load every requested book file in parallel.
  const bookFiles = await Promise.all(
    slugs.map(({ slug }) => loadBook(slug, book)),
  );
  if (bookFiles.some((b) => !b)) return null;

  // Merge: walk verses of the first translation as the spine, then
  // overlay the others' per-verse text. Bundled translations all share
  // the same OSIS verse_id scheme, so verse_id matching is exact.
  const primary = bookFiles[0]![String(chapter)];
  if (!primary) return null;

  const verses: BibleVerseMulti[] = primary.map((v) => ({
    verse_id: v.verse_id,
    book: v.book,
    chapter: v.chapter,
    verse: v.verse,
    translations: [...v.translations],
  }));

  for (let i = 1; i < bookFiles.length; i++) {
    const file = bookFiles[i]!;
    const chapterVerses = file[String(chapter)];
    if (!chapterVerses) continue;
    const byId = new Map(chapterVerses.map((v) => [v.verse_id, v]));
    for (const v of verses) {
      const other = byId.get(v.verse_id);
      if (other && other.translations[0]) {
        v.translations.push(other.translations[0]);
      }
    }
  }

  return {
    book,
    chapter,
    translations: slugs.map((s) => s.name),
    verses,
  };
}

export async function hasLocalBundle(): Promise<boolean> {
  const m = await getManifest();
  return !!m;
}

/** Names of translations the bundle covers locally. UI can use this
 *  to surface a 'Available offline' affordance in the picker. */
export async function bundledTranslationNames(): Promise<string[]> {
  const m = await getManifest();
  return m?.translations ?? [];
}

/**
 * Full-Bible plain-text search over a bundled translation.
 *
 * Returns null when the requested translation isn't bundled (caller
 * falls back to the server). When bundled, walks every book of that
 * translation in canonical order and returns the first `limit`
 * verses whose text (case-insensitive) contains the trimmed query.
 *
 * Phrase semantics: a multi-word query matches verses that contain
 * the exact phrase. (No tokenization / no stemming. Bible study
 * users overwhelmingly search for exact phrasing — "by faith",
 * "love thy neighbor", "whoever believes" — so phrase match wins
 * over a more clever-but-surprising approach.)
 */
export async function searchLocalBible(
  q: string,
  translation: string | undefined,
  limit: number,
): Promise<BibleSearchHit[] | null> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const manifest = await getManifest();
  if (!manifest) return null;
  // Default to KJV when caller omits a translation — matches the
  // backend route's behavior (it returns the deployment's primary
  // translation when none is specified).
  const target = translation || "King James Version";
  const slug = manifest.translation_slugs[target];
  if (!slug) return null;

  // Preload every book file in parallel. After the first search they
  // all sit in the in-memory `cache` so subsequent queries are
  // effectively memory-only.
  const allBooks = await Promise.all(
    manifest.books.map((book) => loadBook(slug, book)),
  );

  const needle = trimmed.toLowerCase();
  const hits: BibleSearchHit[] = [];

  outer: for (let i = 0; i < manifest.books.length; i++) {
    const file = allBooks[i];
    if (!file) continue;
    // Sort chapters numerically so John 3:16 ranks before John 21:1.
    const chapters = Object.keys(file)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    for (const chapter of chapters) {
      const verses = file[String(chapter)];
      if (!verses) continue;
      for (const v of verses) {
        const t = v.translations[0];
        if (!t || !t.text) continue;
        if (t.text.toLowerCase().includes(needle)) {
          hits.push({
            verse_id: v.verse_id,
            book: v.book,
            chapter: v.chapter,
            verse: v.verse,
            text: t.text,
            translation: t.name,
          });
          if (hits.length >= limit) break outer;
        }
      }
    }
  }

  return hits;
}
