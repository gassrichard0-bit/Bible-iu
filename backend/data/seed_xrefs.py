"""Seed the cross-reference graph (CLAUDE.md §7.4).

Source: OpenBible.info's Treasury of Scripture Knowledge data
(https://a.openbible.info/data/cross-references.zip), licensed CC-BY.

The TSK file is ~344k tab-separated rows of (from, to, votes). Verse
refs use friendly book abbreviations (Gen, Exod, Ps, etc.); we map
those to the OSIS codes already in the Verse table.

Per `CLAUDE.md` §7.4, every cross-ref carries a `relation_type`. TSK
doesn't distinguish thematic/quotation/parallel — we record all as
`thematic` for now; future enrichment can refine via curated lists.

Run:
    python -m backend.data.seed_xrefs
"""
from __future__ import annotations

import io
import os
import sys
import urllib.request
import zipfile
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import CrossReference, Verse


SOURCE_URL = "https://a.openbible.info/data/cross-references.zip"
LICENSE = "CC-BY (OpenBible.info)"
RELATION = "thematic"

# Minimum votes to include — TSK includes very-low-confidence links; we
# filter to keep retrieval focused. 0 = keep all.
MIN_VOTES = int(os.environ.get("BIBLE_IU_XREF_MIN_VOTES", "1"))

# TSK book abbreviation → OSIS code (must match the Verse table seeding).
ABBR_TO_OSIS: dict[str, str] = {
    "Gen": "GEN", "Exod": "EXO", "Lev": "LEV", "Num": "NUM",
    "Deut": "DEU", "Josh": "JOS", "Judg": "JDG", "Ruth": "RUT",
    "1Sam": "1SA", "2Sam": "2SA", "1Kgs": "1KI", "2Kgs": "2KI",
    "1Chr": "1CH", "2Chr": "2CH", "Ezra": "EZR", "Neh": "NEH",
    "Esth": "EST", "Job": "JOB", "Ps": "PSA", "Prov": "PRO",
    "Eccl": "ECC", "Song": "SNG", "Isa": "ISA", "Jer": "JER",
    "Lam": "LAM", "Ezek": "EZK", "Dan": "DAN", "Hos": "HOS",
    "Joel": "JOL", "Amos": "AMO", "Obad": "OBA", "Jonah": "JON",
    "Mic": "MIC", "Nah": "NAM", "Hab": "HAB", "Zeph": "ZEP",
    "Hag": "HAG", "Zech": "ZEC", "Mal": "MAL",
    "Matt": "MAT", "Mark": "MRK", "Luke": "LUK", "John": "JHN",
    "Acts": "ACT", "Rom": "ROM", "1Cor": "1CO", "2Cor": "2CO",
    "Gal": "GAL", "Eph": "EPH", "Phil": "PHP", "Col": "COL",
    "1Thess": "1TH", "2Thess": "2TH", "1Tim": "1TI", "2Tim": "2TI",
    "Titus": "TIT", "Phlm": "PHM", "Heb": "HEB", "Jas": "JAS",
    "1Pet": "1PE", "2Pet": "2PE", "1John": "1JN", "2John": "2JN",
    "3John": "3JN", "Jude": "JUD", "Rev": "REV",
}


def _to_verse_id(ref: str) -> str | None:
    """Convert "Gen.1.1" → "GEN.1.1". Range references collapse to the start.

    Returns None for unknown books.
    """
    # Range: take the LHS of the dash.
    if "-" in ref:
        ref = ref.split("-", 1)[0]
    parts = ref.split(".")
    if len(parts) != 3:
        return None
    book_abbr, chapter, verse = parts
    osis = ABBR_TO_OSIS.get(book_abbr)
    if osis is None:
        return None
    return f"{osis}.{chapter}.{verse}"


def _download() -> bytes:
    print(f"Fetching {SOURCE_URL} …", flush=True)
    req = urllib.request.Request(
        SOURCE_URL,
        headers={"User-Agent": "Bible-IU seed-script"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def seed() -> None:
    init_db()
    with Session(engine) as session:
        existing = session.scalar(select(CrossReference.id))
        if existing:
            count = session.query(CrossReference).count()
            print(f"Cross-references already seeded ({count} rows). Skipping.")
            return

        # Load TSK from /tmp cache if present (dev convenience), else fetch.
        cache = "/tmp/cross_references.txt"
        if os.path.exists(cache):
            with open(cache, "rb") as f:
                tsk_bytes = f.read()
        else:
            data = _download()
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                name = next(n for n in zf.namelist() if n.endswith(".txt"))
                with zf.open(name) as f:
                    tsk_bytes = f.read()

        # Build a set of valid verse_ids so we don't insert FK rows that
        # point at verses we don't have (e.g. apocryphal references).
        valid: set[str] = {
            v for (v,) in session.execute(select(Verse.id)).all()
        }
        print(f"  {len(valid)} verses in DB")

        rows: list[dict] = []
        skipped_book = 0
        skipped_votes = 0
        skipped_missing = 0
        kept = 0

        for raw in tsk_bytes.decode("utf-8").splitlines():
            if not raw or raw.startswith("#") or raw.startswith("From"):
                continue
            parts = raw.split("\t")
            if len(parts) < 2:
                continue
            from_ref, to_ref = parts[0], parts[1]
            votes_str = parts[2] if len(parts) > 2 else "0"
            try:
                votes = int(votes_str)
            except ValueError:
                votes = 0
            if votes < MIN_VOTES:
                skipped_votes += 1
                continue

            from_id = _to_verse_id(from_ref)
            to_id = _to_verse_id(to_ref)
            if from_id is None or to_id is None:
                skipped_book += 1
                continue
            if from_id not in valid or to_id not in valid:
                skipped_missing += 1
                continue

            rows.append({
                "id": str(uuid4()),
                "from_verse_id": from_id,
                "to_verse_id": to_id,
                "relation_type": RELATION,
            })
            kept += 1

            # Flush in batches to keep memory manageable.
            if len(rows) >= 10000:
                session.bulk_insert_mappings(CrossReference, rows)
                session.commit()
                rows.clear()
                print(f"  …{kept} inserted", flush=True)

        if rows:
            session.bulk_insert_mappings(CrossReference, rows)
            session.commit()

        print(
            f"Done. {kept} cross-refs inserted "
            f"(skipped: book={skipped_book}, votes={skipped_votes}, "
            f"missing_verse={skipped_missing}). License: {LICENSE}"
        )


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
