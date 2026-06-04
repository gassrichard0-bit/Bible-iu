"""Seed the original-language anchor + an Arabic reference translation.

Per `CLAUDE.md` §7.1 and `rule-guide.MD` §2.1, scripture's ground truth
is the original-language text. This script adds three more rows to the
Translation table per verse:

    - Hebrew  (Westminster Leningrad Codex / "codex" via getbible.net)
    - Greek   (Textus Receptus 1550 / "textusreceptus" via getbible.net)
    - Arabic  (Smith & Van Dyke 1865 / "arabicsv" via getbible.net)

The Hebrew row applies to OT books (1-39), Greek to NT (40-66), Arabic
to both. All three are public domain. Each row records its license per
`CLAUDE.md` §7.6.

Run from the repo root:
    python -m backend.data.seed_originals

Idempotent: if a translation already exists for a verse it is skipped.
"""
from __future__ import annotations

import json
import sys
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Translation


BASE = "https://api.getbible.net/v2"

# (translation_name, getbible_abbr, license, book_range_inclusive)
SOURCES: list[tuple[str, str, str, tuple[int, int]]] = [
    ("Hebrew (WLC)", "codex", "Public Domain (Westminster Leningrad Codex)", (1, 39)),
    ("Greek (TR)", "textusreceptus", "Public Domain (Textus Receptus 1550)", (40, 66)),
    ("Arabic (SVD)", "arabicsv", "Public Domain (Smith & Van Dyke 1865)", (1, 66)),
]

# OSIS codes in canonical 1-66 order (matches the KJV seed).
OSIS_BY_NUM: list[str] = [
    "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT",
    "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH",
    "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER",
    "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON",
    "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
    "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO",
    "GAL", "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI",
    "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN",
    "3JN", "JUD", "REV",
]


_UA = "Mozilla/5.0 (Bible-IU seed-script; +https://bible.access-term.com)"


def _fetch(abbr: str, book_num: int) -> dict:
    url = f"{BASE}/{abbr}/{book_num}.json"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def seed_one(
    session: Session,
    translation_name: str,
    abbr: str,
    license_text: str,
    book_range: tuple[int, int],
) -> int:
    """Seed one translation. Returns the number of rows inserted."""
    existing = session.scalar(
        select(Translation.id).where(Translation.name == translation_name)
    )
    if existing:
        print(f"  {translation_name}: already seeded, skipping")
        return 0

    rows: list[dict] = []
    id_prefix = abbr.upper()
    start, end = book_range
    for book_num in range(start, end + 1):
        code = OSIS_BY_NUM[book_num - 1]
        print(f"  fetching {translation_name} {code}…", flush=True)
        try:
            data = _fetch(abbr, book_num)
        except Exception as e:
            print(f"    failed: {e}", file=sys.stderr)
            continue
        for ch in data.get("chapters", []):
            chapter_num = int(ch["chapter"])
            for v in ch.get("verses", []):
                verse_num = int(v["verse"])
                verse_id = f"{code}.{chapter_num}.{verse_num}"
                rows.append({
                    "id": f"{id_prefix}:{verse_id}",
                    "name": translation_name,
                    "verse_id": verse_id,
                    "text": v.get("text", "").strip(),
                    "license": license_text,
                })

    if rows:
        print(f"  inserting {len(rows)} {translation_name} rows…")
        session.bulk_insert_mappings(Translation, rows)
        session.commit()
    return len(rows)


def seed() -> None:
    init_db()
    with Session(engine) as session:
        total = 0
        for translation_name, abbr, lic, book_range in SOURCES:
            total += seed_one(session, translation_name, abbr, lic, book_range)
        print(f"Done. {total} rows seeded.")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
