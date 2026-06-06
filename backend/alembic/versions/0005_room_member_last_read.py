"""room_members.last_read_at

Revision ID: 0005_room_member_last_read
Revises: 0004_room_accent_color
Create Date: 2026-06-06

Adds `room_members.last_read_at` so `GET /rooms` can return an
`unread_count` per room (chat messages newer than the cutoff, from
anyone other than the caller). Powers the in-app unread badges.

Null = "never opened". The unread query treats null as "everything is
unread since you joined" via COALESCE against `created_at`.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0005_room_member_last_read"
down_revision: str | None = "0004_room_accent_color"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "room_members",
        sa.Column("last_read_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("room_members", "last_read_at")
