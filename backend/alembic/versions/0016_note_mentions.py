"""note_mentions table — dedupes @mention push notifications per note

Revision ID: 0016_note_mentions
Revises: 0015_annotation_offsets
Create Date: 2026-06-11

One row per (note_id, user_id) the first time a member is tagged in a
note. The unique constraint is what dedupes — POSTing the same handles
again is a no-op so the frontend can fire on every save without
spamming subscribers.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0016_note_mentions"
down_revision: str | None = "0015_annotation_offsets"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "note_mentions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "note_id",
            sa.String(),
            sa.ForeignKey("notes.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "room_id",
            sa.String(),
            sa.ForeignKey("rooms.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "note_id", "user_id", name="uq_note_mentions_note_user",
        ),
    )


def downgrade() -> None:
    op.drop_table("note_mentions")
