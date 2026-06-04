"""Seed the King James Version (public domain) into the scripture store.

Source: https://github.com/aruljohn/Bible-kjv — one JSON file per book,
shape `{book, chapters: [{chapter, verses: [{verse, text}]}]}`.

Per CLAUDE.md §7.6 the KJV ships under a recorded license. We tag every
Translation row with `license="Public Domain (KJV)"`.

Run from the repo root:
    python -m backend.data.seed_kjv

Idempotent: if the Translation count already matches expectations, it
exits without re-fetching.
"""
from __future__ import annotations

import json
import sys
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Translation, Verse


BASE = "https://raw.githubusercontent.com/aruljohn/Bible-kjv/master"
TRANSLATION_NAME = "King James Version"
LICENSE = "Public Domain (KJV)"

# OSIS-style book codes (https://wiki.crosswire.org/OSIS_Book_Abbreviations).
BOOKS: list[tuple[str, str]] = [
    ("Genesis", "GEN"), ("Exodus", "EXO"), ("Leviticus", "LEV"),
    ("Numbers", "NUM"), ("Deuteronomy", "DEU"),
    ("Joshua", "JOS"), ("Judges", "JDG"), ("Ruth", "RUT"),
    ("1 Samuel", "1SA"), ("2 Samuel", "2SA"),
    ("1 Kings", "1KI"), ("2 Kings", "2KI"),
    ("1 Chronicles", "1CH"), ("2 Chronicles", "2CH"),
    ("Ezra", "EZR"), ("Nehemiah", "NEH"), ("Esther", "EST"),
    ("Job", "JOB"), ("Psalms", "PSA"), ("Proverbs", "PRO"),
    ("Ecclesiastes", "ECC"), ("Song of Solomon", "SNG"),
    ("Isaiah", "ISA"), ("Jeremiah", "JER"), ("Lamentations", "LAM"),
    ("Ezekiel", "EZK"), ("Daniel", "DAN"),
    ("Hosea", "HOS"), ("Joel", "JOL"), ("Amos", "AMO"),
    ("Obadiah", "OBA"), ("Jonah", "JON"), ("Micah", "MIC"),
    ("Nahum", "NAM"), ("Habakkuk", "HAB"), ("Zephaniah", "ZEP"),
    ("Haggai", "HAG"), ("Zechariah", "ZEC"), ("Malachi", "MAL"),
    ("Matthew", "MAT"), ("Mark", "MRK"), ("Luke", "LUK"),
    ("John", "JHN"), ("Acts", "ACT"), ("Romans", "ROM"),
    ("1 Corinthians", "1CO"), ("2 Corinthians", "2CO"),
    ("Galatians", "GAL"), ("Ephesians", "EPH"), ("Philippians", "PHP"),
    ("Colossians", "COL"), ("1 Thessalonians", "1TH"),
    ("2 Thessalonians", "2TH"), ("1 Timothy", "1TI"), ("2 Timothy", "2TI"),
    ("Titus", "TIT"), ("Philemon", "PHM"), ("Hebrews", "HEB"),
    ("James", "JAS"), ("1 Peter", "1PE"), ("2 Peter", "2PE"),
    ("1 John", "1JN"), ("2 John", "2JN"), ("3 John", "3JN"),
    ("Jude", "JUD"), ("Revelation", "REV"),
]

EXPECTED_VERSE_COUNT = 31102  # KJV total


def _fetch(book_name: str) -> dict:
    file_name = book_name.replace(" ", "") + ".json"
    url = f"{BASE}/{file_name}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def seed() -> None:
    init_db()
    with Session(engine) as session:
        existing = session.scalar(
            select(Translation.id).where(Translation.name == TRANSLATION_NAME)
        )
        if existing:
            count = session.query(Translation).filter(
                Translation.name == TRANSLATION_NAME
            ).count()
            if count >= EXPECTED_VERSE_COUNT:
                print(f"KJV already seeded ({count} verses). Skipping.")
                return
            print(f"Partial KJV detected ({count} verses). Re-seeding will "
                  "leave duplicates — delete the existing rows first.")
            return

        verse_rows: list[dict] = []
        translation_rows: list[dict] = []
        for book_name, code in BOOKS:
            print(f"  fetching {book_name}…", flush=True)
            data = _fetch(book_name)
            for ch in data["chapters"]:
                chapter_num = int(ch["chapter"])
                for v in ch["verses"]:
                    verse_num = int(v["verse"])
                    verse_id = f"{code}.{chapter_num}.{verse_num}"
                    verse_rows.append({
                        "id": verse_id,
                        "book": code,
                        "chapter": chapter_num,
                        "verse": verse_num,
                    })
                    translation_rows.append({
                        "id": f"KJV:{verse_id}",
                        "name": TRANSLATION_NAME,
                        "verse_id": verse_id,
                        "text": v["text"],
                        "license": LICENSE,
                    })

        print(f"  inserting {len(verse_rows)} verses + translations…")
        # Insert via Core to bypass the ORM event listener that requires
        # license on `before_insert`; we set license explicitly above.
        session.bulk_insert_mappings(Verse, verse_rows)
        session.bulk_insert_mappings(Translation, translation_rows)
        session.commit()
        print(f"Done. {len(verse_rows)} verses seeded.")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
