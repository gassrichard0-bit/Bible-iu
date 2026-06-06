"""room avatar — add image_token column

Revision ID: 0002_room_image_token
Revises: 0001_baseline
Create Date: 2026-06-06

Adds `rooms.image_token` — opaque cache-busting token for the room's
avatar. The file itself lives on disk at
`backend/data/uploads/rooms/{room_id}.webp`; the token changes on
every successful upload so the browser refetches.

Nullable, default null. Existing rooms get the gradient/initials
fallback in the UI until an admin uploads an image.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0002_room_image_token"
down_revision: str | None = "0001_baseline"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("image_token", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rooms", "image_token")
