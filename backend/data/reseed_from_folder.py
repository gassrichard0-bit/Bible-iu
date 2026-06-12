"""Re-seed a translation from the JSON folder that
`extract_translation_to_folder.py` produced.

Pairs with the extract step: if SQLite ever gets wiped, point this at
the folder and the translation is back without touching the publisher
API. The license string baked into `manifest.json` (the publisher's
required copyright text) is stamped onto every Translation row, so
attribution survives the round-trip.

Usage:
    python -m backend.data.reseed_from_folder backend/data/bibles/NKJV
    python -m backend.data.reseed_from_folder backend/data/bibles/NIV --force

`--force` re-imports even if the translation already has rows. Without
it, an existing translation by the same name is left alone.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import engine, init_db
from .models import Translation, Verse


def reseed(folder: Path, force: bool = False) -> None:
    manifest_path = folder / "manifest.json"
    if not manifest_path.exists():
        print(f"FAILED: no manifest at {manifest_path}", file=sys.stderr)
        sys.exit(1)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    name = manifest["translation_name"]
    license_text = manifest["attribution"]

    init_db()
    with Session(engine) as session:
        existing = session.query(Translation).filter(
            Translation.name == name
        ).count()
        if existing and not force:
            print(
                f"{name!r} already has {existing} rows. "
                "Pass --force to wipe and re-seed."
            )
            return
        if existing and force:
            print(f"Wiping {existing} existing rows of {name!r}…")
            session.query(Translation).filter(
                Translation.name == name
            ).delete(synchronize_session=False)
            session.commit()

        existing_verses = set(session.scalars(select(Verse.id)).all())
        verse_rows: list[dict] = []
        translation_rows: list[dict] = []
        book_files = sorted(p for p in folder.iterdir() if p.suffix == ".json"
                            and p.name != "manifest.json")
        for path in book_files:
            payload = json.loads(path.read_text(encoding="utf-8"))
            code = payload["book"]
            for ch in payload.get("chapters", []):
                chapter_num = int(ch.get("chapter") or 0)
                for v in ch.get("verses", []):
                    verse_num = int(v.get("verse") or 0)
                    text = (v.get("text") or "").strip()
                    if not (chapter_num and verse_num and text):
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
                        "id": f"{folder.name}:{verse_id}",
                        "name": name,
                        "verse_id": verse_id,
                        "text": text,
                        "license": license_text,
                    })

        print(
            f"  inserting {len(verse_rows)} new verse rows + "
            f"{len(translation_rows)} translation rows…"
        )
        if verse_rows:
            session.bulk_insert_mappings(Verse, verse_rows)
        session.bulk_insert_mappings(Translation, translation_rows)
        session.commit()
        print(f"Done. {len(translation_rows)} {name} verses re-seeded.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Folder produced by extract step.")
    parser.add_argument("--force", action="store_true",
                        help="Wipe + re-seed if rows already exist.")
    args = parser.parse_args(argv)
    if not args.folder.is_dir():
        parser.error(f"{args.folder} is not a directory")
    reseed(args.folder, force=args.force)


if __name__ == "__main__":
    main()
