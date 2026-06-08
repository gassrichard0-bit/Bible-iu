"""translations_fts FTS5 index

Revision ID: 0012_translations_fts
Revises: 0011_chat_pinned_at
Create Date: 2026-06-08

Adds an FTS5 virtual table mirroring `translations.text` so the Bible
search endpoint can do stemmed full-text matches ("loving" finds
"love") instead of plain substring AND.

Note on shape: `translations.id` is a String (UUID), not INTEGER, so we
can't use FTS5's external-content + content_rowid linkage (that needs
an INTEGER rowid). Instead we store the verse_id + translation name
directly in the FTS5 table as UNINDEXED columns, populated by triggers
that mirror the source rows.

If the SQLite build doesn't have FTS5 compiled in, the migration is a
no-op — `bible_search` falls back to its LIKE path automatically.
"""
from __future__ import annotations

from alembic import op


revision: str = "0012_translations_fts"
down_revision: str | None = "0011_chat_pinned_at"
branch_labels: str | None = None
depends_on: str | None = None


def _fts5_available(conn) -> bool:
    """Detect whether the current SQLite build supports FTS5."""
    try:
        conn.exec_driver_sql(
            "CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)"
        )
        conn.exec_driver_sql("DROP TABLE _fts5_probe")
        return True
    except Exception:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        # Postgres deployments would use tsvector; deferred.
        return
    if not _fts5_available(bind):
        return

    # Standalone FTS5 table. `text` is the only indexed column; the
    # rest are UNINDEXED so they round-trip without bloating the index.
    op.execute("DROP TABLE IF EXISTS translations_fts")
    op.execute(
        "CREATE VIRTUAL TABLE translations_fts USING fts5("
        "  text,"
        "  verse_id UNINDEXED,"
        "  translation_name UNINDEXED,"
        "  tokenize='porter unicode61'"
        ")"
    )

    # Backfill from any existing translation rows.
    op.execute(
        "INSERT INTO translations_fts(text, verse_id, translation_name) "
        "SELECT text, verse_id, name FROM translations"
    )

    # Sync triggers so the mirror stays current on future inserts /
    # updates / deletes.
    op.execute("DROP TRIGGER IF EXISTS translations_fts_ai")
    op.execute("DROP TRIGGER IF EXISTS translations_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS translations_fts_au")
    op.execute(
        "CREATE TRIGGER translations_fts_ai "
        "AFTER INSERT ON translations BEGIN "
        "  INSERT INTO translations_fts(text, verse_id, translation_name) "
        "  VALUES (new.text, new.verse_id, new.name); "
        "END"
    )
    op.execute(
        "CREATE TRIGGER translations_fts_ad "
        "AFTER DELETE ON translations BEGIN "
        "  DELETE FROM translations_fts "
        "  WHERE verse_id = old.verse_id "
        "    AND translation_name = old.name; "
        "END"
    )
    op.execute(
        "CREATE TRIGGER translations_fts_au "
        "AFTER UPDATE ON translations BEGIN "
        "  DELETE FROM translations_fts "
        "  WHERE verse_id = old.verse_id "
        "    AND translation_name = old.name; "
        "  INSERT INTO translations_fts(text, verse_id, translation_name) "
        "  VALUES (new.text, new.verse_id, new.name); "
        "END"
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        return
    op.execute("DROP TRIGGER IF EXISTS translations_fts_au")
    op.execute("DROP TRIGGER IF EXISTS translations_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS translations_fts_ai")
    op.execute("DROP TABLE IF EXISTS translations_fts")
