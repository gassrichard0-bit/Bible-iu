"""note_mentions.note_id: drop FK to notes(id)

Revision ID: 0017_note_mentions_drop_fk
Revises: 0016_note_mentions
Create Date: 2026-06-11

Group notes don't live in the `notes` table — they live in Yjs (with
`registered_group_notes` as the membership-allowlist anchor). NoteLike
and NoteComment already declare `note_id` as a plain indexed string
without a FK to `notes(id)` for exactly this reason. NoteMention was
incorrectly declared WITH the FK in 0016, so every INSERT for a
group-note tag failed `PRAGMA foreign_keys=ON` enforcement and the
push was silently never sent.

Since `note_mentions` is empty in production today (the bug means no
row ever landed), the simplest rebuild is drop + recreate.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0017_note_mentions_drop_fk"
down_revision: str | None = "0016_note_mentions"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.drop_table("note_mentions")
    op.create_table(
        "note_mentions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("note_id", sa.String(), nullable=False, index=True),
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
