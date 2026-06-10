"""note_likes.kind

Revision ID: 0013_note_like_kind
Revises: 0012_translations_fts
Create Date: 2026-06-10

Adds a `kind` column to note_likes so a user can stack different
reactions on the same group note (heart, thumbsup, …). The unique
constraint moves from (note_id, user_id) to (note_id, user_id, kind).

Existing rows are backfilled to `kind = 'heart'` so the old
single-reaction state maps cleanly onto the new schema.

SQLite doesn't support dropping an unnamed unique constraint with a
plain ALTER, so we use op.batch_alter_table with an explicit
`copy_from` Table definition that omits the old constraint. Alembic
recreates the table with only the new (note_id, user_id, kind)
uniqueness and copies the data over.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0013_note_like_kind"
down_revision: str | None = "0012_translations_fts"
branch_labels: str | None = None
depends_on: str | None = None


def _copy_from() -> sa.Table:
    """Source schema for batch_alter_table to copy data out of. We
    deliberately OMIT the old unnamed (note_id, user_id) unique
    constraint here — alembic's batch ops can't drop an unnamed
    constraint by name (`drop_constraint(None, ...)` raises
    "Constraint must have a name"), so the cleanest way to be rid of
    it is to leave it out of the copy_from definition. Alembic then
    builds the new table with only what we declare here + whatever
    we add inside the batch block."""
    meta = sa.MetaData()
    return sa.Table(
        "note_likes",
        meta,
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
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def upgrade() -> None:
    with op.batch_alter_table("note_likes", copy_from=_copy_from()) as batch:
        batch.add_column(
            sa.Column("kind", sa.String(), nullable=False, server_default="heart")
        )
        batch.create_unique_constraint(
            "uq_note_likes_note_user_kind",
            ["note_id", "user_id", "kind"],
        )
        batch.create_index("ix_note_likes_kind", ["kind"])


def downgrade() -> None:
    with op.batch_alter_table("note_likes") as batch:
        batch.drop_index("ix_note_likes_kind")
        batch.drop_constraint("uq_note_likes_note_user_kind", type_="unique")
        batch.drop_column("kind")
        batch.create_unique_constraint(
            "uq_note_likes_note_user", ["note_id", "user_id"]
        )
