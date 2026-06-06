"""room accent — add accent_color column

Revision ID: 0004_room_accent_color
Revises: 0003_user_avatar_image_token
Create Date: 2026-06-06

Per-room accent color picked by an admin from a fixed palette
(amber/rose/violet/sky/emerald/lime/fuchsia/slate). Stored as the
palette key string; the frontend maps it to CSS. Null means "auto-
derived from room id" — the default.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0004_room_accent_color"
down_revision: str | None = "0003_user_avatar_image_token"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("accent_color", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rooms", "accent_color")
