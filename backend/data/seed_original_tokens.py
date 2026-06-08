"""Seed `original_tokens` — per-word Hebrew/Greek anchor (CLAUDE.md §7.1).

The Translation table already holds the Hebrew/Greek **text** (seeded
by `seed_originals.py`). This script adds the per-word morphology +
Strong's anchor that the agent needs to ground original-language
claims (rule-guide §2.1).

Sources (both openly licensed):

  OT  →  Open Scriptures Hebrew Bible (OSHB)
         https://github.com/openscriptures/morphhb
         CC-BY 4.0
         Per-book OSIS XML with <w lemma="…" morph="…">surface</w>.

  NT  →  MorphGNT (SBLGNT base text + morph)
         https://github.com/morphgnt/sblgnt
         CC-BY-SA 3.0
         Space-separated text: BCV POS parse surface norm lemma1 lemma2.

Output is one `OriginalToken` row per word, in document order
(`position` 1-indexed within the verse). Strong's is recorded for
OT (OSHB embeds it in the lemma); NT rows leave `strongs` null
because MorphGNT itself doesn't include it — a future pass can join
against Bible Strong's tables.

Idempotent: if any tokens exist for a verse, that verse is skipped.
That lets us re-run after a partial failure without doubling rows.

Run from the repo root:
    python3 -m backend.data.seed_original_tokens

Add `--only=GEN` to seed a single book for a quick test, or
`--ot` / `--nt` to limit the half.
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import OriginalToken


_OSHB_URL = (
    "https://raw.githubusercontent.com/openscriptures/morphhb/master/wlc/{book}.xml"
)
_MORPHGNT_URL = (
    "https://raw.githubusercontent.com/morphgnt/sblgnt/master/"
    "{num:02d}-{book}-morphgnt.txt"
)
_UA = "Mozilla/5.0 (Bible-IU seed-script; +https://bible.access-term.com)"
_OSIS_NS = "{http://www.bibletechnologies.net/2003/OSIS/namespace}"


# OSHB filenames use SBL-style book abbreviations. OSIS in our DB
# uses uppercase 3-letter codes. Map the two.
_OSHB_BOOKS: list[tuple[str, str]] = [
    ("Gen", "GEN"), ("Exod", "EXO"), ("Lev", "LEV"), ("Num", "NUM"),
    ("Deut", "DEU"), ("Josh", "JOS"), ("Judg", "JDG"), ("Ruth", "RUT"),
    ("1Sam", "1SA"), ("2Sam", "2SA"), ("1Kgs", "1KI"), ("2Kgs", "2KI"),
    ("1Chr", "1CH"), ("2Chr", "2CH"), ("Ezra", "EZR"), ("Neh", "NEH"),
    ("Esth", "EST"), ("Job", "JOB"), ("Ps", "PSA"), ("Prov", "PRO"),
    ("Eccl", "ECC"), ("Song", "SNG"), ("Isa", "ISA"), ("Jer", "JER"),
    ("Lam", "LAM"), ("Ezek", "EZK"), ("Dan", "DAN"), ("Hos", "HOS"),
    ("Joel", "JOL"), ("Amos", "AMO"), ("Obad", "OBA"), ("Jonah", "JON"),
    ("Mic", "MIC"), ("Nah", "NAM"), ("Hab", "HAB"), ("Zeph", "ZEP"),
    ("Hag", "HAG"), ("Zech", "ZEC"), ("Mal", "MAL"),
]


# MorphGNT filenames: NN-Abbr-morphgnt.txt where NN is the BIBLE-WIDE
# book number (OT 01-39 + NT 40-66 + apocrypha, so SBLGNT files are
# numbered 61-87). The repo's actual filenames are `61-Mt-...txt`
# through `87-Re-...txt`.
_MORPHGNT_BOOKS: list[tuple[int, str, str]] = [
    (61, "Mt", "MAT"), (62, "Mk", "MRK"), (63, "Lk", "LUK"), (64, "Jn", "JHN"),
    (65, "Ac", "ACT"), (66, "Ro", "ROM"), (67, "1Co", "1CO"), (68, "2Co", "2CO"),
    (69, "Ga", "GAL"), (70, "Eph", "EPH"), (71, "Php", "PHP"), (72, "Col", "COL"),
    (73, "1Th", "1TH"), (74, "2Th", "2TH"), (75, "1Ti", "1TI"), (76, "2Ti", "2TI"),
    (77, "Tit", "TIT"), (78, "Phm", "PHM"), (79, "Heb", "HEB"), (80, "Jas", "JAS"),
    (81, "1Pe", "1PE"), (82, "2Pe", "2PE"), (83, "1Jn", "1JN"), (84, "2Jn", "2JN"),
    (85, "3Jn", "3JN"), (86, "Jud", "JUD"), (87, "Re", "REV"),
]


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def _strongs_from_lemma(lemma: str) -> str | None:
    """OSHB lemmas look like `b/7225` (prefix + Strong's), `1254 a`
    (Strong's + homonym discriminator), or just `7225`. Pull the
    rightmost integer run and prefix with H for Hebrew."""
    nums = re.findall(r"\d+", lemma)
    if not nums:
        return None
    return f"H{nums[-1]}"


def _iter_oshb_tokens(
    xml_bytes: bytes,
    osis_book: str,
) -> Iterable[dict]:
    """Yield one token dict per <w> element in the book's XML."""
    root = ET.fromstring(xml_bytes)
    # Walk <verse> elements anywhere under the tree (depth varies by
    # OSIS structuring). osisID looks like "Gen.1.1".
    for verse in root.iter(f"{_OSIS_NS}verse"):
        osis_id = verse.get("osisID")
        if not osis_id:
            continue
        # OSHB sometimes splits a verse across paragraphs; the `eID`
        # closing element has no children. Only ingest the opening
        # tag that actually contains words.
        parts = osis_id.split(".")
        if len(parts) != 3:
            continue
        try:
            chapter = int(parts[1])
            verse_n = int(parts[2])
        except ValueError:
            continue
        verse_id = f"{osis_book}.{chapter}.{verse_n}"
        position = 0
        for w in verse.iter(f"{_OSIS_NS}w"):
            surface = (w.text or "").strip()
            if not surface:
                continue
            lemma = (w.get("lemma") or "").strip()
            morph = (w.get("morph") or "").strip()
            position += 1
            yield {
                "id": f"oshb:{verse_id}:{position}",
                "verse_id": verse_id,
                "position": position,
                "surface_form": surface,
                "lemma": lemma,
                "strongs": _strongs_from_lemma(lemma),
                "morphology": morph,
                "lexicon_entry": None,
            }


def _iter_morphgnt_tokens(
    text: str,
    osis_book: str,
) -> Iterable[dict]:
    """Yield one token dict per line of the MorphGNT TSV."""
    last_verse_id: str | None = None
    position = 0
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        fields = line.split()
        if len(fields) < 7:
            continue
        bcv, _pos, parse, surface, _norm, _lemma1, lemma2 = fields[:7]
        if len(bcv) != 6 or not bcv.isdigit():
            continue
        try:
            chapter = int(bcv[2:4])
            verse_n = int(bcv[4:6])
        except ValueError:
            continue
        verse_id = f"{osis_book}.{chapter}.{verse_n}"
        if verse_id != last_verse_id:
            last_verse_id = verse_id
            position = 0
        position += 1
        yield {
            "id": f"sblgnt:{verse_id}:{position}",
            "verse_id": verse_id,
            "position": position,
            "surface_form": surface,
            "lemma": lemma2,
            "strongs": None,  # MorphGNT alone doesn't carry Strong's
            "morphology": parse,
            "lexicon_entry": None,
        }


def _already_seeded(session: Session, osis_book: str) -> bool:
    """Skip an entire book if any token row already references one
    of its verses (idempotency)."""
    row = session.execute(
        select(OriginalToken.id)
        .where(OriginalToken.verse_id.like(f"{osis_book}.%"))
        .limit(1)
    ).first()
    return row is not None


def _bulk_insert(session: Session, rows: list[dict]) -> int:
    if not rows:
        return 0
    # Chunk inserts so SQLite doesn't choke on the parameter limit.
    n = 0
    chunk = 5000
    for i in range(0, len(rows), chunk):
        session.bulk_insert_mappings(OriginalToken, rows[i : i + chunk])
        n += min(chunk, len(rows) - i)
    session.commit()
    return n


def seed_ot(session: Session, only: set[str] | None = None) -> int:
    total = 0
    for oshb_name, osis in _OSHB_BOOKS:
        if only and osis not in only:
            continue
        if _already_seeded(session, osis):
            print(f"  OT {osis}: already seeded, skipping")
            continue
        url = _OSHB_URL.format(book=oshb_name)
        print(f"  fetching OSHB {osis} ({oshb_name})…", flush=True)
        try:
            data = _fetch(url)
        except Exception as e:
            print(f"    failed: {e}", file=sys.stderr)
            continue
        rows = list(_iter_oshb_tokens(data, osis))
        n = _bulk_insert(session, rows)
        print(f"    {osis}: {n} tokens")
        total += n
    return total


def seed_nt(session: Session, only: set[str] | None = None) -> int:
    total = 0
    for num, slug, osis in _MORPHGNT_BOOKS:
        if only and osis not in only:
            continue
        if _already_seeded(session, osis):
            print(f"  NT {osis}: already seeded, skipping")
            continue
        url = _MORPHGNT_URL.format(num=num, book=slug)
        print(f"  fetching MorphGNT {osis} ({slug})…", flush=True)
        try:
            text = _fetch(url).decode("utf-8")
        except Exception as e:
            print(f"    failed: {e}", file=sys.stderr)
            continue
        rows = list(_iter_morphgnt_tokens(text, osis))
        n = _bulk_insert(session, rows)
        print(f"    {osis}: {n} tokens")
        total += n
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated OSIS codes, e.g. GEN,EXO")
    ap.add_argument("--ot", action="store_true", help="OT only")
    ap.add_argument("--nt", action="store_true", help="NT only")
    args = ap.parse_args()
    only = (
        {x.strip().upper() for x in args.only.split(",") if x.strip()}
        if args.only
        else None
    )
    init_db()
    with Session(engine) as session:
        ot_total = 0
        nt_total = 0
        if not args.nt:
            ot_total = seed_ot(session, only)
        if not args.ot:
            nt_total = seed_nt(session, only)
        print(f"Done. OT={ot_total} NT={nt_total} total={ot_total + nt_total}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
