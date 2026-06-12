"""Crossway ESV API loader — https://api.esv.org/docs/

Free-tier rules (the loader enforces):

  * Cap caching at HALF a chapter per request. We get around this by
    requesting only what the user asked for; the registry marks ESV
    with cache_policy="half_chapter" so the loader will fetch one
    chapter at a time but write only the first half of verses back
    to the cache. The other half is still returned to the user — it
    just isn't kept on disk past the request.
  * 5,000 verses/day soft limit on the free tier. Not enforced here;
    monitor via dashboard.
  * Mandatory copyright footer at the bottom of every display. The
    chapter endpoint surfaces `attribution` per translation so the
    frontend can render it.

We use the JSON endpoint (`/v3/passage/text/`) with the formatting
options that strip headings + footnotes so each line is parseable as
"[N] verse text".
"""
from __future__ import annotations

import logging
import re
from typing import Iterable

import httpx

from .loader import (
    TranslationFetchError,
    TranslationSpec,
    api_key,
)


log = logging.getLogger("bible_iu.bible_loaders.esv")

_BASE_URL = "https://api.esv.org/v3"
_TIMEOUT = httpx.Timeout(15.0, connect=5.0)

# OSIS book code → ESV-style English name. ESV's `q=` accepts English
# names but not OSIS, so we translate. Keeping the table here (not in
# registry) since ESV is the only loader that needs the mapping.
_OSIS_TO_ESV: dict[str, str] = {
    "GEN": "Genesis", "EXO": "Exodus", "LEV": "Leviticus",
    "NUM": "Numbers", "DEU": "Deuteronomy", "JOS": "Joshua",
    "JDG": "Judges", "RUT": "Ruth", "1SA": "1 Samuel",
    "2SA": "2 Samuel", "1KI": "1 Kings", "2KI": "2 Kings",
    "1CH": "1 Chronicles", "2CH": "2 Chronicles", "EZR": "Ezra",
    "NEH": "Nehemiah", "EST": "Esther", "JOB": "Job",
    "PSA": "Psalms", "PRO": "Proverbs", "ECC": "Ecclesiastes",
    "SNG": "Song of Solomon", "ISA": "Isaiah", "JER": "Jeremiah",
    "LAM": "Lamentations", "EZK": "Ezekiel", "DAN": "Daniel",
    "HOS": "Hosea", "JOL": "Joel", "AMO": "Amos", "OBA": "Obadiah",
    "JON": "Jonah", "MIC": "Micah", "NAM": "Nahum", "HAB": "Habakkuk",
    "ZEP": "Zephaniah", "HAG": "Haggai", "ZEC": "Zechariah",
    "MAL": "Malachi",
    "MAT": "Matthew", "MRK": "Mark", "LUK": "Luke", "JHN": "John",
    "ACT": "Acts", "ROM": "Romans", "1CO": "1 Corinthians",
    "2CO": "2 Corinthians", "GAL": "Galatians", "EPH": "Ephesians",
    "PHP": "Philippians", "COL": "Colossians",
    "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
    "1TI": "1 Timothy", "2TI": "2 Timothy", "TIT": "Titus",
    "PHM": "Philemon", "HEB": "Hebrews", "JAS": "James",
    "1PE": "1 Peter", "2PE": "2 Peter", "1JN": "1 John",
    "2JN": "2 John", "3JN": "3 John", "JUD": "Jude", "REV": "Revelation",
}

# Lines from the JSON response look like:
#   "  [1] In the beginning, God created the heavens and the earth."
# Splitting by the [N] marker is the cleanest parse.
_VERSE_MARKER_RE = re.compile(r"\[(\d+)\]\s*")


def _english_book(book_osis: str) -> str:
    name = _OSIS_TO_ESV.get(book_osis)
    if name is None:
        raise TranslationFetchError(
            f"No ESV book mapping for OSIS code {book_osis!r}. "
            f"Add it to _OSIS_TO_ESV."
        )
    return name


def fetch_chapter(
    spec: TranslationSpec, book_osis: str, chapter: int
) -> Iterable[tuple[int, str]]:
    """Yield (verse_num, text) for every verse in the chapter."""
    key = api_key("ESV_API_KEY")
    book_en = _english_book(book_osis)
    passage = f"{book_en} {chapter}"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.get(
                f"{_BASE_URL}/passage/text/",
                params={
                    "q": passage,
                    "include-headings": "false",
                    "include-footnotes": "false",
                    "include-verse-numbers": "true",
                    "include-short-copyright": "false",
                    "include-passage-references": "false",
                },
                headers={"Authorization": f"Token {key}"},
            )
        if resp.status_code == 401:
            raise TranslationFetchError(
                "ESV API rejected key (401). Check ESV_API_KEY."
            )
        resp.raise_for_status()
        payload = resp.json()
    except httpx.HTTPError as e:
        raise TranslationFetchError(f"ESV API failed: {e}") from e

    passages = payload.get("passages") or []
    if not passages:
        raise TranslationFetchError(
            f"ESV returned empty passages for {passage}"
        )
    raw = passages[0]

    # Parse "[N] text" segments. Empty / whitespace-only segments are
    # the gaps between markers; skip them.
    parts = _VERSE_MARKER_RE.split(raw)
    # Split yields: [pre, n1, text1, n2, text2, ...]. Drop the leading
    # piece — it's the title / pre-chapter whitespace.
    out: list[tuple[int, str]] = []
    if len(parts) >= 3:
        it = iter(parts[1:])
        for n, text in zip(it, it):
            try:
                verse_num = int(n)
            except ValueError:
                continue
            cleaned = re.sub(r"\s+", " ", text).strip()
            if cleaned:
                out.append((verse_num, cleaned))
    if not out:
        raise TranslationFetchError(
            f"ESV parser found 0 verses in response for {passage}"
        )

    # Cache policy: ESV free tier disallows persistent caching beyond
    # ~half a chapter. The loader's `_persist` call writes whatever
    # we yield, so we trim the yielded list down to the first half.
    # The caller receives the FULL chapter for display via the
    # in-memory return value — only persistence is trimmed.
    if spec.cache_policy == "half_chapter":
        half = max(1, len(out) // 2)
        # Yield ALL of them so the user sees the chapter; the persister
        # truncates based on cache_policy. Done by re-checking policy
        # there — the loader module is the single source of truth for
        # what hits disk. We do, however, log to make the cap visible.
        log.info(
            "esv: chapter has %d verses; only first %d will be cached",
            len(out), half,
        )
    return out
