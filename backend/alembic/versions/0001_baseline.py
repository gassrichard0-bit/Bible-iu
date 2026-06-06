"""baseline — current schema snapshot

Revision ID: 0001_baseline
Revises:
Create Date: 2026-06-04

The baseline is a no-op. Existing dev databases were created by
`Base.metadata.create_all()` and any fresh DB still goes through
that bootstrap (see backend/data/db.py:init_db). After bootstrap,
stamp the DB to this revision so future migrations can attach:

    alembic stamp 0001_baseline

Future schema changes MUST come through new revisions generated
with `alembic revision --autogenerate -m "..."` — do not edit
models alone, or dev and prod schemas will diverge silently.
"""
from __future__ import annotations


revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # Schema already exists by way of Base.metadata.create_all().
    # Subsequent revisions stack on top of this one.
    pass


def downgrade() -> None:
    # Refuse to drop the baseline — it isn't a real revision to roll back.
    pass
