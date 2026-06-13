"""Dump the entire KJV Bible to per-book JSON files for the iOS bundle.

Run once after any DB reseed; output drops into
`frontend/public/bible-data/{OSIS}.json` so Vite picks them up and
Capacitor ships them inside the iOS app bundle. The frontend's
`localBible.ts` loads them as the offline-first source of truth for
KJV requests — when the device is offline OR the KJV-only fetch
short-circuits, no network round-trip is needed.

Shape per file matches the live `/api/bible/{book}/{chapter}/multi`
response so the frontend can substitute it without any reshaping:

  {
    "GEN": {
      "1": [
        { "verse_id": "GEN.1.1", "book": "GEN", "chapter": 1, "verse": 1,
          "translations": [{ "name": "King James Version",
                             "text": "...", "direction": "ltr",
                             "license": "Public Domain" }] },
        ...
      ],
      "2": [...]
    }
  }

KJV is public domain — no licensing concern about redistributing.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = REPO_ROOT / "backend" / "data" / "bible-iu.sqlite"
OUT_DIR = REPO_ROOT / "frontend" / "public" / "bible-data"

# Public-domain English translations bundled inside the iOS IPA. Keep
# this list to genuinely public-domain entries — anything licensed
# (NIV, NKJV) MUST stay server-only or we breach the
# publisher agreement.
BUNDLED_TRANSLATIONS = [
    "King James Version",
    "World English Bible",
    "Berean Standard Bible",
    "Young's Literal Translation",
    "Darby Bible",
]


def main() -> int:
    if not DB_PATH.exists():
        print(f"DB not found at {DB_PATH}", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    manifest_books: set[str] = set()
    grand_total = 0

    for translation in BUNDLED_TRANSLATIONS:
        slug = _slug(translation)
        cur.execute(
            """
            SELECT v.book, v.chapter, v.verse, v.id AS verse_id,
                   t.text, t.license
              FROM verses v
              JOIN translations t ON t.verse_id = v.id
             WHERE t.name = ?
             ORDER BY v.book, v.chapter, v.verse
            """,
            (translation,),
        )

        # Group: book -> chapter -> [verse dicts]
        by_book: dict[str, dict[int, list[dict]]] = {}
        for row in cur.fetchall():
            book = row["book"]
            chapter = int(row["chapter"])
            verse_dict = {
                "verse_id": row["verse_id"],
                "book": book,
                "chapter": chapter,
                "verse": int(row["verse"]),
                "translations": [
                    {
                        "name": translation,
                        "text": row["text"],
                        "direction": "ltr",
                        "license": row["license"] or "Public Domain",
                    }
                ],
            }
            by_book.setdefault(book, {}).setdefault(chapter, []).append(
                verse_dict
            )

        if not by_book:
            print(f"  (skipping {translation} — no rows in DB)")
            continue

        translation_dir = OUT_DIR / slug
        translation_dir.mkdir(parents=True, exist_ok=True)
        translation_total = 0
        for book, chapters in by_book.items():
            out_data: dict[str, list[dict]] = {
                str(c): chapters[c] for c in sorted(chapters)
            }
            out_path = translation_dir / f"{book}.json"
            out_path.write_text(
                json.dumps(out_data, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            translation_total += sum(len(v) for v in out_data.values())
            manifest_books.add(book)

        print(f"{translation}: {translation_total} verses → {slug}/")
        grand_total += translation_total

    manifest = {
        "translations": BUNDLED_TRANSLATIONS,
        "translation_slugs": {t: _slug(t) for t in BUNDLED_TRANSLATIONS},
        "books": sorted(manifest_books),
        "total_verses": grand_total,
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"\nTotal verses across all bundled translations: {grand_total}")
    print(f"Output: {OUT_DIR}")
    return 0


def _slug(name: str) -> str:
    """Folder-safe slug for a translation name. Keeps ASCII alnum +
    underscore so paths work everywhere (Windows, iOS bundle, etc.)."""
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "/", "(", ")", "."):
            out.append("_")
    s = "".join(out)
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")


if __name__ == "__main__":
    raise SystemExit(main())
