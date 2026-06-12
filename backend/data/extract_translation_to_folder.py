"""Dump a cached translation from SQLite into a portable folder of
JSON files — one file per book, plus a manifest with the publisher's
attribution. The point is reproducibility: the API key can rot, the
SQLite file can get wiped, and we can re-seed from these JSON files
without ever calling the publisher again.

Output layout (defaults to `backend/data/bibles/`):

  backend/data/bibles/
    NKJV/
      manifest.json          (translation name, attribution, source,
                              total verses, generated_at)
      GEN.json               { "book": "GEN", "name": "Genesis",
                               "chapters": [
                                 { "chapter": 1,
                                   "verses": [{ "verse": 1, "text": "..." }, ...] }
                               , ...] }
      EXO.json
      ...
    NIV/
      manifest.json
      GEN.json
      ...

Folder name = the registry entry's `display_label` (e.g. NKJV, NIV)
falling back to a sanitized version of the canonical name when the
label is empty.

Usage:
    python -m backend.data.extract_translation_to_folder "New King James Version"
    python -m backend.data.extract_translation_to_folder "New International Version"
    python -m backend.data.extract_translation_to_folder --all-remote
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..bible_loaders.registry import (
    TranslationSpec,
    all_specs,
    get as registry_get,
)
from .db import engine
from .models import Translation, Verse
from .seed_kjv import BOOKS


_BIBLES_DIR_DEFAULT = (
    Path(__file__).resolve().parent / "bibles"
)


_BOOK_NAMES = {code: label for label, code in BOOKS}


def _folder_label(spec: TranslationSpec) -> str:
    """Pick the directory name. Prefer the short `display_label`
    (NKJV / NIV / KJV / etc.) so the layout reads well on disk."""
    if spec.display_label:
        return spec.display_label
    return re.sub(r"[^A-Za-z0-9_-]+", "_", spec.name).strip("_") or spec.name


def export(name: str, out_root: Path) -> Path:
    spec = registry_get(name)
    if spec is None:
        raise SystemExit(
            f"{name!r} is not in the registry — add it before exporting."
        )

    out_dir = out_root / _folder_label(spec)
    out_dir.mkdir(parents=True, exist_ok=True)

    with Session(engine) as session:
        rows = session.execute(
            select(Translation, Verse)
            .join(Verse, Verse.id == Translation.verse_id)
            .where(Translation.name == name)
            .order_by(Verse.book, Verse.chapter, Verse.verse)
        ).all()
        if not rows:
            raise SystemExit(
                f"No cached rows for {name!r}. Run "
                "`prefetch_remote_translation` first."
            )

        by_book: dict[str, dict[int, list[dict]]] = {}
        for t, v in rows:
            chapters = by_book.setdefault(v.book, {})
            chapters.setdefault(v.chapter, []).append(
                {"verse": v.verse, "text": t.text}
            )

        # Write one JSON file per book. Books are sorted in canonical
        # order so a diff is meaningful if we ever re-extract. BOOKS
        # is `[(label, code), ...]` from the seed module.
        for _label, code in BOOKS:
            chapters_map = by_book.get(code)
            if not chapters_map:
                continue
            chapters_sorted = [
                {
                    "chapter": ch,
                    "verses": chapters_map[ch],
                }
                for ch in sorted(chapters_map.keys())
            ]
            book_payload = {
                "book": code,
                "name": _BOOK_NAMES.get(code, code),
                "chapters": chapters_sorted,
            }
            (out_dir / f"{code}.json").write_text(
                json.dumps(book_payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        # Manifest carries the publisher's required attribution string
        # verbatim — same one stored in Translation.license. A future
        # re-seeder reads this to stamp the license back on.
        verse_count = len(rows)
        manifest = {
            "translation_name": name,
            "display_label": spec.display_label,
            "source": spec.source,
            "source_id": spec.source_id,
            "attribution": spec.attribution,
            "verse_count": verse_count,
            "book_count": len([c for c in by_book if by_book[c]]),
            "chapter_count": sum(len(v) for v in by_book.values()),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        (out_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2),
            encoding="utf-8",
        )

    return out_dir


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "name",
        nargs="?",
        help="Canonical translation name (matches registry.py).",
    )
    parser.add_argument(
        "--all-remote",
        action="store_true",
        help="Export every registry entry with source != 'local'.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=_BIBLES_DIR_DEFAULT,
        help=f"Output root (default {_BIBLES_DIR_DEFAULT}).",
    )
    args = parser.parse_args(argv)

    if args.all_remote:
        names = [s.name for s in all_specs() if s.source != "local"]
        if not names:
            print("No remote translations in the registry.", file=sys.stderr)
            sys.exit(1)
    elif args.name:
        names = [args.name]
    else:
        parser.error("Provide a translation name or pass --all-remote.")

    for n in names:
        try:
            out = export(n, args.out_dir)
            print(f"  exported {n!r} → {out}")
        except SystemExit as e:
            print(f"  SKIP {n!r}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
