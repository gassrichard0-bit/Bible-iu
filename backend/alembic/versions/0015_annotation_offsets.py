"""annotations.start_offset + .end_offset; wider uniqueness

Revision ID: 0015_annotation_offsets
Revises: 0014_email_password_reset
Create Date: 2026-06-10

Lets a single verse carry multiple sub-range annotations of the same
kind (e.g. yellow highlight on "For God so loved" + green highlight
on "everlasting life" within John 3:16). Both offsets null = whole
verse, matching the v1 shape and keeping existing rows valid.

SQLite has no way to drop an unnamed unique constraint by name, so
we use op.batch_alter_table with `copy_from` and omit the old
constraint there — alembic rebuilds the table with only what we
declare, which gives us the wider (user, verse, kind, start, end)
uniqueness without dragging the old (user, verse, kind) along.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0015_annotation_offsets"
down_revision: str | None = "0014_email_password_reset"
branch_labels: str | None = None
depends_on: str | None = None


def _copy_from() -> sa.Table:
    """Source schema for the rebuild. Deliberately omits the old
    (user_id, verse_id, kind) unique constraint so it doesn't survive
    the rebuild — see migration 0013 for the same pattern + rationale."""
    meta = sa.MetaData()
    return sa.Table(
        "annotations",
        meta,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("verse_id", sa.String(), nullable=False, index=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("color", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def upgrade() -> None:
    with op.batch_alter_table("annotations", copy_from=_copy_from()) as batch:
        batch.add_column(sa.Column("start_offset", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("end_offset", sa.Integer(), nullable=True))
        batch.create_unique_constraint(
            "uq_annotations_user_verse_kind_range",
            ["user_id", "verse_id", "kind", "start_offset", "end_offset"],
        )


def downgrade() -> None:
    with op.batch_alter_table("annotations") as batch:
        batch.drop_constraint(
            "uq_annotations_user_verse_kind_range", type_="unique"
        )
        batch.drop_column("end_offset")
        batch.drop_column("start_offset")
        batch.create_unique_constraint(
            "uq_annotations_user_verse_kind", ["user_id", "verse_id", "kind"]
        )
