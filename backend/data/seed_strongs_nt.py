"""Backfill Strong's numbers on the NT OriginalToken rows.

MorphGNT gives us lemma + morphology but not Strong's. The OT side
(OSHB) already embeds Strong's in the lemma attribute, so this
script only touches the NT.

Source: OpenScriptures Strong's Greek dictionary (JSON), CC-BY-SA.
  https://github.com/openscriptures/strongs

Strategy:
  1. Fetch the dictionary, build a `lemma → 'GNNNN'` map. The
     dictionary's `lemma` field is the same lexical form MorphGNT
     uses for its 7th column (lemma2). Where a lemma maps to
     multiple Strong's entries (homonyms), we keep the lowest-
     numbered one as a deterministic tie-break.
  2. For every NT OriginalToken row with `strongs IS NULL`, look
     up its lemma in the map and set `strongs` accordingly. Done
     in one UPDATE statement per book so the operation is fast.
  3. Print coverage stats.

Idempotent: rows whose `strongs` is already set are not touched.

Run from the repo root:
    python3 -m backend.data.seed_strongs_nt
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
import urllib.request

from sqlalchemy import update
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import OriginalToken


_DICT_URL = (
    "https://raw.githubusercontent.com/openscriptures/strongs/master/"
    "greek/strongs-greek-dictionary.js"
)
_UA = "Mozilla/5.0 (Bible-IU seed-script; +https://bible.access-term.com)"


_NT_BOOKS = {
    "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
    "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
    "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
}


def _strip_diacritics(s: str) -> str:
    """Greek lemmas can have varying accentuation between sources;
    fold to bare lowercase letters for the lookup. The dictionary
    uses polytonic forms (ἀρχή); MorphGNT also uses polytonic in
    its `lemma2` column, but punctuation/sigma forms can differ at
    the edges. Stripping accents covers those cases."""
    if not s:
        return s
    nfd = unicodedata.normalize("NFD", s)
    # Strip combining marks (the accents/breathings).
    bare = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
    # Normalize final sigma (ς) to medial sigma (σ) so word-end
    # variants match.
    bare = bare.replace("ς", "σ")
    return bare.lower()


def _fetch_dictionary() -> dict[str, dict]:
    req = urllib.request.Request(_DICT_URL, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
    # The file is a JS module: leading comment block then a var
    # assignment OR an inlined object. The actual JSON object lives
    # between the first `{` after `=` and the matching closing `}`.
    # Strip the JS wrapper to JSON.
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < 0:
        raise RuntimeError("dictionary JSON not found in source")
    raw = text[start : end + 1]
    # The file is actually a single JSON object literal; parse it.
    return json.loads(raw)


def _build_lemma_map(dictionary: dict[str, dict]) -> dict[str, str]:
    """`stripped(lemma) → 'GNNNN'`. Homonyms collapse to the lowest-
    numbered Strong's so the result is deterministic across runs."""
    by_lemma: dict[str, str] = {}
    for strongs_key, entry in dictionary.items():
        lemma = entry.get("lemma")
        if not lemma:
            continue
        key = _strip_diacritics(lemma)
        if not key:
            continue
        # Numeric sort: G1 vs G10 — strip the G prefix, then compare.
        existing = by_lemma.get(key)
        if existing is None or _strongs_int(strongs_key) < _strongs_int(existing):
            by_lemma[key] = strongs_key
    return by_lemma


def _strongs_int(s: str) -> int:
    """Pull the numeric part from a `G1234` key for comparison."""
    m = re.search(r"(\d+)", s or "")
    return int(m.group(1)) if m else 0


def main() -> None:
    init_db()
    print("fetching Strong's Greek dictionary…", flush=True)
    dictionary = _fetch_dictionary()
    lemma_map = _build_lemma_map(dictionary)
    print(f"  loaded {len(dictionary)} entries → {len(lemma_map)} unique lemmas")

    with Session(engine) as session:
        # Iterate per book so progress is visible, and so the
        # SQLAlchemy session can flush incrementally.
        total_examined = 0
        total_updated = 0
        for osis in sorted(_NT_BOOKS):
            # Fetch all NT rows without Strong's, by book.
            rows = (
                session.query(OriginalToken)
                .filter(
                    OriginalToken.verse_id.like(f"{osis}.%"),
                    OriginalToken.strongs.is_(None),
                )
                .all()
            )
            if not rows:
                print(f"  {osis}: nothing to update")
                continue
            updated = 0
            # Group updates by Strong's number so we can do one
            # UPDATE per Strong's value (still cheap, but neater
            # than per-row mutation).
            by_strongs: dict[str, list[str]] = {}
            for row in rows:
                total_examined += 1
                key = _strip_diacritics(row.lemma or "")
                if not key:
                    continue
                s_num = lemma_map.get(key)
                if s_num is None:
                    continue
                by_strongs.setdefault(s_num, []).append(row.id)
            for s_num, ids in by_strongs.items():
                session.execute(
                    update(OriginalToken)
                    .where(OriginalToken.id.in_(ids))
                    .values(strongs=s_num)
                )
                updated += len(ids)
            session.commit()
            total_updated += updated
            print(f"  {osis}: examined={len(rows)} updated={updated}")
        # Coverage report.
        from sqlalchemy import func
        nt_total = (
            session.query(func.count(OriginalToken.id))
            .filter(OriginalToken.verse_id.like("MAT.%"))
            .scalar()
        )  # spot-check just MAT for a hint
        nt_with_strongs = (
            session.query(func.count(OriginalToken.id))
            .filter(
                OriginalToken.verse_id.like("MAT.%"),
                OriginalToken.strongs.is_not(None),
            )
            .scalar()
        )
        print(f"\nDone. examined={total_examined} updated={total_updated}")
        print(
            f"  MAT spot-check: {nt_with_strongs}/{nt_total} tokens now carry Strong's"
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
