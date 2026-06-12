"""Pre-fetch every chapter of a remote translation into the local
cache so the app no longer needs the publisher API for it.

Iterates the full Protestant 66-book canon (1,189 chapters). For each
chapter, calls the loader pipeline which:

  - skips if the chapter is already cached (so re-running is safe);
  - otherwise hits the upstream API once per chapter and writes the
    verses into the `translations` table.

After the run, that translation reads entirely from SQLite — perfect
for the dump-to-folder step (`extract_translation_to_folder.py`),
which then makes the data portable enough that the API key can rot
without losing the text.

Usage:
    python -m backend.data.prefetch_remote_translation "New International Version"
    python -m backend.data.prefetch_remote_translation "New King James Version"

A small per-chapter delay (default 0.3s) keeps us under any reasonable
rate-limit ceiling. The full canon takes about 6-7 minutes.
"""
from __future__ import annotations

import argparse
import sys
import time

from sqlalchemy.orm import Session

from ..bible_loaders.loader import (
    load_chapter,
    TranslationFetchError,
    TranslationMissingKey,
    TranslationNotEnabled,
)
from ..bible_loaders.registry import get as registry_get
from .db import engine, init_db
from .seed_kjv import BOOKS


def _chapter_count_for(session: Session, book_osis: str) -> int:
    """Read the canonical chapter count for a book from the local DB
    (seeded from KJV). Works because the KJV is loaded before any
    paid translation runs through this pipeline."""
    from sqlalchemy import func, select
    from .models import Verse

    res = session.execute(
        select(func.max(Verse.chapter)).where(Verse.book == book_osis)
    ).scalar()
    return int(res or 0)


def prefetch(name: str, delay_s: float = 0.3) -> None:
    spec = registry_get(name)
    if spec is None:
        print(f"FAILED: {name!r} is not in the registry.", file=sys.stderr)
        sys.exit(1)
    if spec.source == "local":
        print(
            f"{name!r} is a local translation — already in the seed db, "
            f"no remote pre-fetch needed."
        )
        return
    if not spec.enabled:
        print(
            f"FAILED: {name!r} is disabled in the registry. "
            "Flip enabled=True before pre-fetching.",
            file=sys.stderr,
        )
        sys.exit(1)

    init_db()
    with Session(engine) as session:
        total_chapters = 0
        fetched = 0
        skipped = 0
        errors: list[tuple[str, int, str]] = []
        for _book_label, code in BOOKS:
            n_chapters = _chapter_count_for(session, code)
            if n_chapters == 0:
                # Book not in the seed db (shouldn't happen for the
                # 66-book canon since KJV seeds it).
                continue
            for chap in range(1, n_chapters + 1):
                total_chapters += 1
                try:
                    # load_chapter is idempotent — it checks the cache
                    # first and returns immediately on hit.
                    from .models import Translation, Verse
                    from sqlalchemy import select
                    existing = session.execute(
                        select(Translation)
                        .join(Verse, Verse.id == Translation.verse_id)
                        .where(
                            Translation.name == name,
                            Verse.book == code,
                            Verse.chapter == chap,
                        )
                        .limit(1)
                    ).scalar_one_or_none()
                    if existing is not None:
                        skipped += 1
                        continue
                    load_chapter(session, name, code, chap)
                    fetched += 1
                    print(
                        f"  [{total_chapters}] {code} {chap} ✓ "
                        f"(fetched: {fetched}, cached: {skipped})",
                        flush=True,
                    )
                    if delay_s > 0:
                        time.sleep(delay_s)
                except (
                    TranslationFetchError,
                    TranslationMissingKey,
                    TranslationNotEnabled,
                ) as e:
                    errors.append((code, chap, str(e)))
                    print(
                        f"  [{total_chapters}] {code} {chap} FAIL: {e}",
                        flush=True,
                    )
        print()
        print(
            f"Done. {fetched} fetched, {skipped} already cached, "
            f"{len(errors)} errors out of {total_chapters} chapters."
        )
        if errors:
            print("Errors:")
            for code, chap, msg in errors:
                print(f"  {code} {chap}: {msg}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "name",
        help="Canonical translation name (must match registry.py), "
        "e.g. 'New International Version'.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.3,
        help="Seconds to sleep between chapter fetches (default 0.3).",
    )
    args = parser.parse_args(argv)
    prefetch(args.name, delay_s=args.delay)


if __name__ == "__main__":
    main()
