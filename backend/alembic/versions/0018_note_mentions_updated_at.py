"""note_mentions.updated_at: TimestampMixin needs both columns

Revision ID: 0018_note_mentions_updated_at
Revises: 0017_note_mentions_drop_fk
Create Date: 2026-06-11

NoteMention inherits TimestampMixin which adds both `created_at` AND
`updated_at`. Migration 0017 only added created_at, so every INSERT
into note_mentions raised `OperationalError: no such column:
note_mentions.updated_at` and the push was silently never sent.

Adding the missing column with the same default + on-update semantic
as TimestampMixin elsewhere. NOT NULL with a CURRENT_TIMESTAMP
default so existing rows (there are none — every prior insert errored
out) would still be valid if any existed.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0018_note_mentions_updated_at"
down_revision: str | None = "0017_note_mentions_drop_fk"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "note_mentions",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )


def downgrade() -> None:
    op.drop_column("note_mentions", "updated_at")
