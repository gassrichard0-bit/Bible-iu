/**
 * Smart-search reference parser + autocomplete for the Bible.
 *
 * Detects three families of input and returns structured intent:
 *   1. Verse reference   "John 3:16"        → book=JHN, chapter=3, verse=16
 *   2. Range reference   "Gen 1:1-3"        → book=GEN, chapter=1, verse=1, verseEnd=3
 *   3. Chapter reference "Psa 23" / "John"  → book=PSA, chapter=23 (or 1 for book-only)
 *
 * Also exposes `suggestReferences(prefix)` for typeahead: given a partial
 * query like "Jo" returns the canonical names of every matching book
 * (John, Jonah, Joel, Job, Joshua) sorted by canon order.
 *
 * The parser is intentionally lenient — it strips punctuation, ignores
 * extra whitespace, accepts dot or colon separators, and tolerates "1
 * John" / "1John" / "I John" interchangeably. The shape of the canon
 * (book → OSIS) is sourced from BOOK_NAME_TO_OSIS in lib/api so it
 * stays in lockstep with the rest of the app.
 */
import { BOOK_NAME_TO_OSIS, OSIS_TO_BOOK_NAME } from "./api";

/** Canonical order of the 66 protestant books — used to sort autocomplete
 *  suggestions. */
const CANON_ORDER: string[] = [
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT",
  "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH",
  "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER",
  "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON",
  "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM",
  "1CO", "2CO", "GAL", "EPH", "PHP", "COL",
  "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
  "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
];
const CANON_INDEX: Record<string, number> = Object.fromEntries(
  CANON_ORDER.map((b, i) => [b, i]),
);

/** Normalize a free-text query for matching — lowercase, strip dots,
 *  collapse whitespace, and convert Roman numerals at the start ("I
 *  John" / "II Sam") into Arabic ("1 John" / "2 Sam"). */
function normalize(raw: string): string {
  let s = raw.toLowerCase().trim();
  // Roman → Arabic for the only ones that show up in book names (1–3).
  s = s.replace(/^iii(\s+|$)/, "3$1");
  s = s.replace(/^ii(\s+|$)/, "2$1");
  s = s.replace(/^i(\s+|$)/, "1$1");
  // Strip punctuation that isn't a separator we care about.
  s = s.replace(/[.–—]/g, " ");
  // Collapse repeated whitespace.
  s = s.replace(/\s+/g, " ");
  return s;
}

/** What the parser recognized in the user's input. */
export type ParsedReference = {
  book: string; // OSIS code
  bookDisplay: string; // human-readable name
  chapter: number;
  verse?: number;
  verseEnd?: number;
};

/**
 * Match the LONGEST book name (or abbreviation) at the start of `s`.
 * Returns the OSIS code + the tail (the rest of the string after the
 * book) so the caller can keep parsing chapter:verse. Returns null
 * when no book matches.
 *
 * We try with-space ("1 john") AND no-space ("1john") variants because
 * users type both. Longest match wins so "1 john" beats "1" (which
 * isn't even a key).
 */
function extractBook(
  s: string,
): { osis: string; rest: string } | null {
  // Strategy: try each entry in BOOK_NAME_TO_OSIS sorted by descending
  // length of key, looking for a match at the start. Try both spaced
  // ("1 john") and spaceless ("1john") forms of the input.
  const candidates = Object.keys(BOOK_NAME_TO_OSIS).sort(
    (a, b) => b.length - a.length,
  );
  const spaceless = s.replace(/\s+/g, "");
  for (const key of candidates) {
    // Spaced match: input begins with `key` followed by end-of-string,
    // space, or digit (so "ge" doesn't swallow the 'g' in "gen").
    const re = new RegExp(
      `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|\\d|$)`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      const matched = s.slice(0, m[0].length);
      return {
        osis: BOOK_NAME_TO_OSIS[key],
        rest: s.slice(matched.length).trimStart(),
      };
    }
    // Spaceless match — useful for "1john3:16".
    const reSpaceless = new RegExp(
      `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\d|$)`,
      "i",
    );
    const m2 = spaceless.match(reSpaceless);
    if (m2) {
      // We matched against the spaceless form, but we need to consume
      // the corresponding prefix from the ORIGINAL (with-space) input.
      // Walk through `s`, skipping spaces, until we've consumed `key.length`
      // non-space chars.
      let i = 0;
      let consumed = 0;
      while (i < s.length && consumed < key.length) {
        if (!/\s/.test(s[i])) consumed++;
        i++;
      }
      return {
        osis: BOOK_NAME_TO_OSIS[key],
        rest: s.slice(i).trimStart(),
      };
    }
  }
  return null;
}

/**
 * Parse a free-text query into a verse / chapter / range reference.
 * Returns null when the input doesn't lead with a recognizable book.
 *
 * Accepts (lowercase, post-normalize):
 *   "john"                 → JHN 1
 *   "john 3"               → JHN 3
 *   "john 3:16"            → JHN 3:16
 *   "john 3 16"            → JHN 3:16
 *   "1 john 3:16"          → 1JN 3:16
 *   "1john 3:16"           → 1JN 3:16
 *   "i john 3:16"          → 1JN 3:16
 *   "gen 1:1-3"            → GEN 1:1–3
 *   "psa 23"               → PSA 23
 */
export function parseReference(input: string): ParsedReference | null {
  const cleaned = normalize(input);
  if (!cleaned) return null;
  const book = extractBook(cleaned);
  if (!book) return null;
  const bookDisplay = OSIS_TO_BOOK_NAME[book.osis] ?? book.osis;
  const tail = book.rest;
  if (!tail) {
    // Bare book name — open the book at chapter 1.
    return { book: book.osis, bookDisplay, chapter: 1 };
  }
  // Chapter [:|.| ] verse [- verseEnd]
  // Examples we want to accept: "3", "3:16", "3.16", "3 16", "3:16-18",
  // "3:16–18" (em dash already normalized to space).
  const m = tail.match(
    /^(\d+)(?:[\s:]+(\d+)(?:\s*-\s*(\d+))?)?\s*$/,
  );
  if (!m) {
    // Tail looks like garbage after the book name — fall back to
    // chapter 1 so a typo doesn't kill the reference outright.
    return { book: book.osis, bookDisplay, chapter: 1 };
  }
  const chapter = Number(m[1]);
  const verse = m[2] ? Number(m[2]) : undefined;
  const verseEnd = m[3] ? Number(m[3]) : undefined;
  return {
    book: book.osis,
    bookDisplay,
    chapter,
    verse,
    verseEnd: verseEnd && verseEnd > (verse ?? 0) ? verseEnd : undefined,
  };
}

/**
 * Typeahead: return up to `limit` book names whose human display name
 * starts with `prefix` (case-insensitive). "Jo" → John, Joel, Jonah,
 * Job, Joshua (canon order). Empty prefix returns []; non-letter
 * input returns []. Used by the search popup to surface jump
 * suggestions before the user has typed a full reference.
 */
export function suggestReferences(
  prefix: string,
  limit = 6,
): { osis: string; display: string }[] {
  const cleaned = normalize(prefix);
  if (!cleaned) return [];
  // Don't autocomplete once the user has typed a chapter / verse —
  // their intent is clearly a reference, not a book picker.
  if (/\d/.test(cleaned.split(" ")[0] ?? "")) {
    // If the first token starts with a number ("1 jo"), keep matching
    // against book names with leading "1". Otherwise (e.g. "3"), bail.
    if (!/^[123]\s|^[123][a-z]/.test(cleaned)) return [];
  }
  const seen = new Set<string>();
  const results: { osis: string; display: string }[] = [];
  for (const osis of CANON_ORDER) {
    if (seen.has(osis)) continue;
    const display = OSIS_TO_BOOK_NAME[osis];
    if (!display) continue;
    // Case-insensitive prefix match against the human name OR any of
    // its abbreviations in BOOK_NAME_TO_OSIS.
    const displayLower = display.toLowerCase();
    const matchesDisplay = displayLower.startsWith(cleaned);
    // For multi-word display ("1 Corinthians"), also accept matches
    // against the spaceless form ("1corinth").
    const matchesDisplaySpaceless = displayLower
      .replace(/\s+/g, "")
      .startsWith(cleaned.replace(/\s+/g, ""));
    let matchesAbbrev = false;
    for (const [key, code] of Object.entries(BOOK_NAME_TO_OSIS)) {
      if (code !== osis) continue;
      if (key.startsWith(cleaned.replace(/\s+/g, ""))) {
        matchesAbbrev = true;
        break;
      }
    }
    if (matchesDisplay || matchesDisplaySpaceless || matchesAbbrev) {
      seen.add(osis);
      results.push({ osis, display });
      if (results.length >= limit) break;
    }
  }
  // Sort by canon order so 1 Corinthians (book 46) doesn't beat
  // 1 Chronicles (book 13) on alphabetical accident.
  results.sort(
    (a, b) => (CANON_INDEX[a.osis] ?? 99) - (CANON_INDEX[b.osis] ?? 99),
  );
  return results;
}

/**
 * Format a parsed reference back to a human-readable string. Useful
 * for the "Jump to ..." tile label.
 */
export function formatReference(r: ParsedReference): string {
  if (r.verse == null) return `${r.bookDisplay} ${r.chapter}`;
  if (r.verseEnd == null) return `${r.bookDisplay} ${r.chapter}:${r.verse}`;
  return `${r.bookDisplay} ${r.chapter}:${r.verse}–${r.verseEnd}`;
}
