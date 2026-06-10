"""Generic seeder for any public-domain (or freely-usable) translation
hosted on bolls.life.

Picks up the same JSON shape as the existing WEB seeder:

    [ { "book": 1, "chapter": 1, "verse": 1, "text": "..." }, ... ]

where `book` is 1..66 in canonical Protestant order (matches the
numbering in `seed_kjv.BOOKS`).

Usage:
    python -m backend.data.seed_bolls_translation YLT
    python -m backend.data.seed_bolls_translation BSB --name "Berean Standard Bible" --license "Public Domain (BSB 2022)"

When the short-name is one of the known entries below, the human name +
license string are auto-filled. Pass `--name` / `--license` to override
or to seed a translation not in the table.

Idempotent: skips if the row count already meets the per-translation
expectation; refuses to top up a partial seed (delete the existing
rows first to avoid integrity confusion).
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Translation, Verse
from .seed_kjv import BOOKS  # canonical 66-book OSIS map


# Known free / public-domain translations hosted by bolls.life.
# Keys are bolls's `short_name` (== the JSON filename); values are
# (display name, license attribution).
KNOWN: dict[str, tuple[str, str]] = {
    "YLT": (
        "Young's Literal Translation",
        "Public Domain (Young's Literal Translation 1898)",
    ),
    "BSB": (
        "Berean Standard Bible",
        "Free for any use (Berean Standard Bible 2022) — bereanbible.com",
    ),
    "GNV": (
        "Geneva Bible (1599)",
        "Public Domain (Geneva Bible 1599)",
    ),
    "DRB": (
        "Douay-Rheims Bible",
        "Public Domain (Douay-Rheims Bible 1899)",
    ),
    "NET": (
        "New English Translation",
        "Free for any use (NET Bible text — netbible.org)",
    ),
}


# Some translations include the deuterocanon / are otherwise larger
# than the 66-book Protestant canon; others are shorter (e.g. NT-only).
# Verse counts are approximate, picked low enough to allow legitimate
# variance without misclassifying a partial seed as "already done".
EXPECTED_MIN_VERSE_COUNT = 28_000


def _book_code_by_index() -> dict[int, str]:
    """1-indexed Protestant canon → OSIS code (matches bolls.life)."""
    return {i + 1: code for i, (_, code) in enumerate(BOOKS)}


def _fetch(short_name: str) -> list[dict]:
    url = f"https://bolls.life/static/translations/{short_name}.json"
    print(f"  fetching {url}…", flush=True)
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def seed(short_name: str, name: str, license_text: str) -> None:
    init_db()
    with Session(engine) as session:
        existing_count = session.query(Translation).filter(
            Translation.name == name
        ).count()
        if existing_count >= EXPECTED_MIN_VERSE_COUNT:
            print(f"{name} already seeded ({existing_count} verses). Skipping.")
            return
        if existing_count:
            print(
                f"Partial {name} detected ({existing_count} verses). "
                "Delete the existing rows before re-running."
            )
            return

        try:
            raw = _fetch(short_name)
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
            # Strip rudimentary HTML that some translations embed
            # (small caps for the divine name, italics, etc.). The
            # model is plain prose; styling is a renderer concern.
            text = _strip_inline_html(text)
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
                "id": f"{short_name}:{verse_id}",
                "name": name,
                "verse_id": verse_id,
                "text": text,
                "license": license_text,
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
        print(f"Done. {len(translation_rows)} {name} verses seeded.")


_HTML_TAG = __import__("re").compile(r"<[^>]+>")
_WS_RUN = __import__("re").compile(r"\s+")


def _strip_inline_html(text: str) -> str:
    """Drop inline HTML, collapse whitespace, normalise non-breaking
    spaces. Cheap pass — fine for the renderer-agnostic plain-text
    representation we store."""
    out = _HTML_TAG.sub("", text)
    out = out.replace(" ", " ")
    return _WS_RUN.sub(" ", out).strip()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "short_name",
        help="Bolls short name, e.g. YLT, BSB, GNV, DRB, NET.",
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
    args = parser.parse_args(argv)
    short = args.short_name.upper()
    default = KNOWN.get(short)
    name = args.name or (default[0] if default else None)
    license_text = args.license_text or (default[1] if default else None)
    if not name or not license_text:
        parser.error(
            f"Unknown short name '{short}'. Pass --name and --license."
        )
    seed(short, name, license_text)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
