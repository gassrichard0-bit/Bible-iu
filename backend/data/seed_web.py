"""Seed the World English Bible (public domain) into the scripture store.

The WEB is a modern public-domain translation derived from the ASV
1901. Closes the "stuck at 1611" gap without licensing fees.

Source: https://bolls.life/static/translations/WEB.json — single
JSON, shape:
    [ { "book": 1, "chapter": 1, "verse": 1, "text": "..." }, ... ]
where `book` is 1..66 in canonical Protestant order.

Run from the repo root:
    python -m backend.data.seed_web

Idempotent — skips if the WEB row count already meets expectations.
"""
from __future__ import annotations

import json
import sys
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Translation, Verse
from .seed_kjv import BOOKS  # canonical 66-book OSIS map


SOURCE_URL = "https://bolls.life/static/translations/WEB.json"
TRANSLATION_NAME = "World English Bible"
LICENSE = "Public Domain (WEB)"

# WEB vs KJV varies by a few hundred verses (different scribal addenda
# conventions). We accept any plausible total instead of hard-coding.
EXPECTED_MIN_VERSE_COUNT = 30_000


def _book_code_by_index() -> dict[int, str]:
    """1-indexed Protestant canon → OSIS code (matches bolls.life's
    numbering, which is the standard 1=Genesis through 66=Revelation)."""
    return {i + 1: code for i, (_, code) in enumerate(BOOKS)}


def _fetch() -> list[dict]:
    print(f"  fetching {SOURCE_URL}…", flush=True)
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def seed() -> None:
    init_db()
    with Session(engine) as session:
        existing_count = session.query(Translation).filter(
            Translation.name == TRANSLATION_NAME
        ).count()
        if existing_count >= EXPECTED_MIN_VERSE_COUNT:
            print(
                f"WEB already seeded ({existing_count} verses). Skipping."
            )
            return
        if existing_count:
            print(
                f"Partial WEB detected ({existing_count} verses). Delete the "
                "existing rows before re-running."
            )
            return

        try:
            raw = _fetch()
        except Exception as e:
            print(f"FAILED: couldn't fetch source ({e})", file=sys.stderr)
            sys.exit(1)
        if not isinstance(raw, list) or not raw:
            print("FAILED: source returned no verses", file=sys.stderr)
            sys.exit(1)

        code_for = _book_code_by_index()
        existing_verses = set(session.scalars(select(Verse.id)).all())

        verse_rows: list[dict] = []
        translation_rows: list[dict] = []
        skipped = 0
        for row in raw:
            book_num = int(row.get("book") or 0)
            chapter_num = int(row.get("chapter") or 0)
            verse_num = int(row.get("verse") or 0)
            text = (row.get("text") or "").strip()
            code = code_for.get(book_num)
            if not (code and chapter_num and verse_num and text):
                skipped += 1
                continue
            verse_id = f"{code}.{chapter_num}.{verse_num}"
            if verse_id not in existing_verses:
                verse_rows.append({
                    "id": verse_id,
                    "book": code,
                    "chapter": chapter_num,
                    "verse": verse_num,
                })
                existing_verses.add(verse_id)
            translation_rows.append({
                "id": f"WEB:{verse_id}",
                "name": TRANSLATION_NAME,
                "verse_id": verse_id,
                "text": text,
                "license": LICENSE,
            })

        print(
            f"  inserting {len(verse_rows)} new verse rows + "
            f"{len(translation_rows)} translation rows "
            f"(skipped {skipped} malformed)…"
        )
        if verse_rows:
            session.bulk_insert_mappings(Verse, verse_rows)
        session.bulk_insert_mappings(Translation, translation_rows)
        session.commit()
        print(f"Done. {len(translation_rows)} WEB verses seeded.")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
