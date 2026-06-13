"""Generic seeder for translations hosted in scrollmapper/bible_databases.

Layout:
    https://raw.githubusercontent.com/scrollmapper/bible_databases/
        master/sources/en/{NAME}/{NAME}.json

JSON shape (Format A):
    {
      "books": [
        {
          "name": "Genesis",
          "chapters": [
            {"chapter": 1, "name": "Genesis 1",
             "verses": [{"verse": 1, "chapter": 1, "name": "Genesis 1:1",
                         "text": "In the beginning…"}, ...]},
            ...
          ]
        },
        ...
      ]
    }

Roman-numeral books ("I Samuel", "II Kings", "III John") are normalized
to Arabic before OSIS lookup. The book-name → OSIS map is built off
the canonical OSIS → English table below — every Protestant-canon
book is represented there.

Usage:
    python -m backend.data.seed_scrollmapper_translation Darby
    python -m backend.data.seed_scrollmapper_translation NHEB
    python -m backend.data.seed_scrollmapper_translation BBE \
        --name "Bible in Basic English" \
        --license "Public Domain in the US (BBE 1949, pre-1928 verify)"

Known short names auto-fill name + license. Pass --name / --license
to override or to seed a translation not in the table.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Translation, Verse

# Canonical OSIS → English book-name table for the Protestant canon.
# Reversed by `_english_to_osis()` below. Deuterocanonical books
# (Tobit, Judith, Sirach, etc.) intentionally not listed — if a
# scrollmapper source includes them, the seeder skips them with a
# warning instead of guessing.
_OSIS_TO_ESV: dict[str, str] = {
    # Old Testament
    "GEN": "Genesis", "EXO": "Exodus", "LEV": "Leviticus",
    "NUM": "Numbers", "DEU": "Deuteronomy", "JOS": "Joshua",
    "JDG": "Judges", "RUT": "Ruth", "1SA": "1 Samuel",
    "2SA": "2 Samuel", "1KI": "1 Kings", "2KI": "2 Kings",
    "1CH": "1 Chronicles", "2CH": "2 Chronicles", "EZR": "Ezra",
    "NEH": "Nehemiah", "EST": "Esther", "JOB": "Job",
    "PSA": "Psalms", "PRO": "Proverbs", "ECC": "Ecclesiastes",
    "SNG": "Song of Solomon", "ISA": "Isaiah", "JER": "Jeremiah",
    "LAM": "Lamentations", "EZK": "Ezekiel", "DAN": "Daniel",
    "HOS": "Hosea", "JOL": "Joel", "AMO": "Amos",
    "OBA": "Obadiah", "JON": "Jonah", "MIC": "Micah",
    "NAM": "Nahum", "HAB": "Habakkuk", "ZEP": "Zephaniah",
    "HAG": "Haggai", "ZEC": "Zechariah", "MAL": "Malachi",
    # New Testament
    "MAT": "Matthew", "MRK": "Mark", "LUK": "Luke", "JHN": "John",
    "ACT": "Acts", "ROM": "Romans", "1CO": "1 Corinthians",
    "2CO": "2 Corinthians", "GAL": "Galatians", "EPH": "Ephesians",
    "PHP": "Philippians", "COL": "Colossians",
    "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
    "1TI": "1 Timothy", "2TI": "2 Timothy", "TIT": "Titus",
    "PHM": "Philemon", "HEB": "Hebrews", "JAS": "James",
    "1PE": "1 Peter", "2PE": "2 Peter", "1JN": "1 John",
    "2JN": "2 John", "3JN": "3 John", "JUD": "Jude",
    "REV": "Revelation",
}


# Known translations on scrollmapper that are free or public-domain.
# Names match the directory names in sources/en. License strings are
# what gets stamped onto Translation.license for every row — kept
# verbatim per CLAUDE.md §7.6.
KNOWN: dict[str, tuple[str, str]] = {
    "Darby": (
        "Darby Bible",
        "Public Domain (Darby Translation, 1890)",
    ),
    "Webster": (
        "Webster's Bible",
        "Public Domain (Webster's Revision of the KJV, 1833)",
    ),
    "Rotherham": (
        "Rotherham's Emphasized Bible",
        "Public Domain (Rotherham's Emphasized Bible, 1902)",
    ),
    "Tyndale": (
        "Tyndale Bible",
        "Public Domain (Tyndale Bible, 1534) — partial (NT + portions of OT)",
    ),
    "JPS": (
        "JPS 1917",
        "Public Domain (Jewish Publication Society Tanakh, 1917) — OT only",
    ),
    "NHEB": (
        "New Heart English Bible",
        "Public Domain (New Heart English Bible)",
    ),
    "OEB": (
        "Open English Bible",
        "CC0 / Public Domain (Open English Bible, openenglishbible.org)",
    ),
    "OEBcth": (
        "Open English Bible (Catholic)",
        "CC0 / Public Domain (OEB Catholic edition, openenglishbible.org)",
    ),
    "CPDV": (
        "Catholic Public Domain Version",
        "Public Domain (Catholic Public Domain Version, 2009)",
    ),
    "AKJV": (
        "American King James Version",
        "Free license (American King James Version, 1999)",
    ),
    "MKJV": (
        "Modern King James Version",
        "Free license (Modern King James Version, 1999)",
    ),
    "LITV": (
        "Literal Translation of the Holy Bible",
        "Free license (Literal Translation of the Holy Bible, 2001)",
    ),
    "Jubilee2000": (
        "Jubilee Bible 2000",
        "Free license (Jubilee Bible 2000)",
    ),
    "UKJV": (
        "Updated King James Version",
        "Free license (Updated King James Version, 2000)",
    ),
    "ACV": (
        "A Conservative Version",
        "Free license (A Conservative Version, 2003)",
    ),
    "RNKJV": (
        "Restored Name King James Version",
        "Free license (Restored Name KJV, 2003)",
    ),
    "RLT": (
        "Revised Literal Translation",
        "Free license (Revised Literal Translation, 2008)",
    ),
    "RWebster": (
        "Revised Webster's Bible",
        "Public Domain (Revised Webster's Bible, 1833 base)",
    ),
    "Anderson": (
        "Anderson's New Testament",
        "Public Domain (Anderson's New Testament, 1866) — NT only",
    ),
    "Noyes": (
        "Noyes' New Testament",
        "Public Domain (Noyes' New Testament, 1869) — NT only",
    ),
    "Haweis": (
        "Haweis' New Testament",
        "Public Domain (Haweis' New Testament, 1795) — NT only",
    ),
    "Twenty": (
        "Twentieth Century New Testament",
        "Public Domain (Twentieth Century NT, 1904) — NT only",
    ),
    "NHEBJE": (
        "New Heart English Bible — Jehovah Edition",
        "Public Domain (NHEB JE)",
    ),
    "NHEBME": (
        "New Heart English Bible — Messianic Edition",
        "Public Domain (NHEB ME)",
    ),
    "KJVA": (
        "King James Version with Apocrypha",
        "Public Domain (KJV with Apocrypha)",
    ),
    "KJVPCE": (
        "King James Version (Pure Cambridge Edition)",
        "Public Domain (KJV Pure Cambridge Edition, 1769)",
    ),
    "LEB": (
        "Lexham English Bible",
        "Free for non-commercial use (Lexham English Bible) — verify before commercial use",
    ),
    "BBE": (
        "Bible in Basic English",
        "Public Domain in the US (Bible in Basic English, 1949)",
    ),
}


_BASE_URL_ROOT = (
    "https://raw.githubusercontent.com/scrollmapper/bible_databases/"
    "master/sources"
)
# Default language is English; the `--language` flag can flip this to
# any other ISO-639 directory present in the repo (e.g. `ru`, `de`).
_BASE_URL = f"{_BASE_URL_ROOT}/en"

EXPECTED_MIN_VERSE_COUNT_FULL = 28_000  # full-canon translation
EXPECTED_MIN_VERSE_COUNT_NT = 7_000  # NT-only translation


_ROMAN_PREFIX_RE = re.compile(r"^(I{1,3}|IV|V?I{0,3})\s+", re.IGNORECASE)
_ROMAN_TO_ARABIC = {"I": "1", "II": "2", "III": "3", "IV": "4"}


def _book_name_to_arabic(name: str) -> str:
    """Convert leading Roman numeral on a book name to Arabic."""
    m = _ROMAN_PREFIX_RE.match(name)
    if not m:
        return name
    roman = m.group(1).upper()
    arabic = _ROMAN_TO_ARABIC.get(roman)
    if arabic is None:
        return name
    return f"{arabic} {name[m.end():]}"


_ALIASES: dict[str, str] = {
    # Common alternate names → canonical English form used in the OSIS table
    "Song of Songs": "Song of Solomon",
    "Canticles": "Song of Solomon",
    "Revelation of John": "Revelation",
    "Revelation to John": "Revelation",
    "The Revelation": "Revelation",
    "Psalm": "Psalms",
}


def _english_to_osis() -> dict[str, str]:
    return {v: k for k, v in _OSIS_TO_ESV.items()}


def _resolve_osis(book_name: str, english_to_osis: dict[str, str]) -> str | None:
    """Map a scrollmapper book name to its OSIS code, or None if it's
    not in the Protestant canon (deuterocanonicals, apocrypha, etc.)."""
    canonical = _book_name_to_arabic(book_name).strip()
    canonical = _ALIASES.get(canonical, canonical)
    return english_to_osis.get(canonical)


def _fetch(short_name: str, language: str = "en") -> dict:
    url = f"{_BASE_URL_ROOT}/{language}/{short_name}/{short_name}.json"
    print(f"  fetching {url}…", flush=True)
    with urllib.request.urlopen(url, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


_HTML_TAG = re.compile(r"<[^>]+>")
_WS_RUN = re.compile(r"\s+")


def _strip_inline_html(text: str) -> str:
    out = _HTML_TAG.sub("", text)
    out = out.replace(" ", " ")
    return _WS_RUN.sub(" ", out).strip()


def seed(
    short_name: str, name: str, license_text: str, language: str = "en"
) -> None:
    init_db()
    with Session(engine) as session:
        existing_count = session.query(Translation).filter(
            Translation.name == name
        ).count()
        # Don't gate on canon-size — NT-only translations are valid
        # and shorter. Any existing rows means we already loaded.
        if existing_count >= EXPECTED_MIN_VERSE_COUNT_NT:
            print(f"{name} already seeded ({existing_count} verses). Skipping.")
            return
        if existing_count:
            print(
                f"Partial {name} detected ({existing_count} verses). "
                "Delete the existing rows before re-running."
            )
            return

        try:
            payload = _fetch(short_name, language=language)
        except Exception as e:
            print(f"FAILED: couldn't fetch source ({e})", file=sys.stderr)
            sys.exit(1)
        books = payload.get("books") or []
        if not books:
            print("FAILED: source returned no books", file=sys.stderr)
            sys.exit(1)

        english_to_osis = _english_to_osis()
        existing_verses = set(session.scalars(select(Verse.id)).all())

        verse_rows: list[dict] = []
        translation_rows: list[dict] = []
        skipped_books: set[str] = set()
        skipped_verses = 0
        for b in books:
            book_name = (b.get("name") or "").strip()
            osis = _resolve_osis(book_name, english_to_osis)
            if osis is None:
                # Deuterocanonical / unknown book; skip silently in
                # the count, but flag it so a one-off translation
                # with apocrypha doesn't quietly lose those books.
                skipped_books.add(book_name)
                continue
            for ch in b.get("chapters") or []:
                chapter_num = int(ch.get("chapter") or 0)
                for v in ch.get("verses") or []:
                    verse_num = int(v.get("verse") or 0)
                    text = _strip_inline_html(v.get("text") or "")
                    if not (chapter_num and verse_num and text):
                        skipped_verses += 1
                        continue
                    verse_id = f"{osis}.{chapter_num}.{verse_num}"
                    if verse_id not in existing_verses:
                        verse_rows.append({
                            "id": verse_id,
                            "book": osis,
                            "chapter": chapter_num,
                            "verse": verse_num,
                        })
                        existing_verses.add(verse_id)
                    translation_rows.append({
                        "id": f"{short_name}:{verse_id}",
                        "name": name,
                        "verse_id": verse_id,
                        "text": text,
                        "license": license_text,
                    })

        if skipped_books:
            print(
                f"  note: skipped {len(skipped_books)} non-canon book(s): "
                f"{', '.join(sorted(skipped_books))}"
            )
        print(
            f"  inserting {len(verse_rows)} new verse rows + "
            f"{len(translation_rows)} translation rows "
            f"(skipped {skipped_verses} malformed)…"
        )
        if verse_rows:
            session.bulk_insert_mappings(Verse, verse_rows)
        session.bulk_insert_mappings(Translation, translation_rows)
        session.commit()
        print(f"Done. {len(translation_rows)} {name} verses seeded.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "short_name",
        help="Scrollmapper directory name (case-sensitive), e.g. Darby, NHEB, JPS.",
    )
    parser.add_argument(
        "--name",
        help="Human-friendly translation name. Default = KNOWN[short_name][0].",
    )
    parser.add_argument(
        "--license",
        dest="license_text",
        help="License attribution. Default = KNOWN[short_name][1].",
    )
    parser.add_argument(
        "--language",
        default="en",
        help="ISO-639 language directory under scrollmapper sources/ "
        "(e.g. en, ru, de). Default 'en'.",
    )
    args = parser.parse_args(argv)
    default = KNOWN.get(args.short_name)
    name = args.name or (default[0] if default else None)
    license_text = args.license_text or (default[1] if default else None)
    if not name or not license_text:
        parser.error(
            f"Unknown short_name {args.short_name!r}. "
            "Pass --name and --license explicitly."
        )
    seed(args.short_name, name, license_text, language=args.language)


if __name__ == "__main__":
    main()
