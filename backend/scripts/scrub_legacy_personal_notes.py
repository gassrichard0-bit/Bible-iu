"""Scrub personal-scope notes out of every room's SHARED Y.Doc.

Background — before the per-user notes split (see yjs_sync.py /
yjsNotes.ts), every note (personal + group) lived in the room's
shared Y.Doc. The frontend filtered personal-scope notes out of the
UI for non-authors, but the bytes were broadcast to every client and
persisted in the shared ystore.db. This script cleans up that leaked
data on disk.

Approach: skip pycrdt's async `SQLiteYStore` (it's anyio-task-group
oriented and deadlocks under a vanilla asyncio.run). Read the
ystore.db directly with sqlite3, replay all updates for each shared
doc onto a fresh `Doc`, delete personal-scope entries from the
`notes` array, then write the resulting state as one new update row.

It does NOT move the personal notes into per-user docs — they were
already exposed, so "migration" doesn't restore privacy. New writes
are routed correctly by the live code (yjsNotes.ts).

Usage:
    python -m backend.scripts.scrub_legacy_personal_notes [--dry-run]

Only the shared room docs (their name is the bare `{room_id}`) are
touched. `conv__{handle}__{roomId}` and
`notes_private__{userId}__{roomId}` docs are left alone.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

from pycrdt import Array, Doc, Map


_STORE_PATH = (
    Path(__file__).resolve().parent.parent / "data" / "yjs" / "ystore.db"
)


def _is_shared_doc_name(name: str) -> bool:
    """The shared room doc's name is the bare room id. Per-user docs
    carry one of the known prefixes; we skip those."""
    return not (
        name.startswith("conv__") or name.startswith("notes_private__")
    )


def _is_personal(item: Map) -> bool:
    return item.get("scope") == "personal"


def _list_paths(conn: sqlite3.Connection) -> list[str]:
    """List distinct doc paths in the ystore. pycrdt's schema is
    private API, so we sniff a couple of candidate table names and
    bail cleanly if neither matches."""
    for table in ("yupdates", "ystore_yupdates", "updates"):
        try:
            cur = conn.execute(
                f"SELECT DISTINCT path FROM {table} ORDER BY path"
            )
            return [row[0] for row in cur.fetchall()]
        except sqlite3.OperationalError:
            continue
    raise RuntimeError(
        "ystore schema not recognized — pycrdt may have changed; "
        "update this script before re-running."
    )


def _fetch_updates(conn: sqlite3.Connection, path: str) -> list[bytes]:
    for table in ("yupdates", "ystore_yupdates", "updates"):
        try:
            cur = conn.execute(
                f"SELECT yupdate FROM {table} WHERE path = ? ORDER BY rowid",
                (path,),
            )
            return [row[0] for row in cur.fetchall()]
        except sqlite3.OperationalError:
            continue
    return []


def _write_update(conn: sqlite3.Connection, path: str, update: bytes) -> None:
    """Append a replacement update. Same table name detection as the
    read path. We use the highest current timestamp + 1 if the
    column is present."""
    for table in ("yupdates", "ystore_yupdates", "updates"):
        try:
            cols = [
                r[1]
                for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
            ]
        except sqlite3.OperationalError:
            continue
        if not cols:
            continue
        if "metadata" in cols and "timestamp" in cols:
            conn.execute(
                f"INSERT INTO {table} (path, yupdate, metadata, timestamp) "
                f"VALUES (?, ?, NULL, strftime('%s','now'))",
                (path, update),
            )
        else:
            placeholders = ", ".join(["?"] * len(cols))
            values = [
                path if c == "path" else update if c == "yupdate" else None
                for c in cols
            ]
            conn.execute(
                f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})",
                values,
            )
        return
    raise RuntimeError("ystore schema not recognized for writes.")


def _scrub_doc(
    conn: sqlite3.Connection, path: str, dry_run: bool
) -> int:
    updates = _fetch_updates(conn, path)
    if not updates:
        return 0
    doc = Doc()
    for u in updates:
        try:
            doc.apply_update(u)
        except Exception:
            # Corrupted / truncated update — skip and keep going.
            continue
    notes = doc.get("notes", type=Array)
    removed = 0
    for i in reversed(range(len(notes))):
        item = notes[i]
        if isinstance(item, Map) and _is_personal(item):
            removed += 1
            if not dry_run:
                del notes[i]
    if removed and not dry_run:
        # The CRDT update encoding the deletes is what we persist.
        # Subsequent client sync sees the deletion and aligns.
        update = doc.get_update()
        _write_update(conn, path, update)
    return removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be scrubbed without modifying the store.",
    )
    args = ap.parse_args()

    if not _STORE_PATH.is_file():
        print(f"no ystore at {_STORE_PATH}; nothing to scrub.")
        return 0

    conn = sqlite3.connect(str(_STORE_PATH))
    try:
        paths = _list_paths(conn)
    except RuntimeError as e:
        print(str(e))
        conn.close()
        return 1

    total = 0
    scanned = 0
    try:
        for name in paths:
            if not _is_shared_doc_name(name):
                continue
            scanned += 1
            removed = _scrub_doc(conn, name, args.dry_run)
            if removed:
                total += removed
                print(
                    f"  {'(dry-run) ' if args.dry_run else ''}{name}: "
                    f"scrubbed {removed} personal note(s)"
                )
        if not args.dry_run:
            conn.commit()
    finally:
        conn.close()

    verb = "would scrub" if args.dry_run else "scrubbed"
    print(
        f"\nscanned {scanned} shared doc(s); {verb} {total} personal note(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
