"""user avatar — add avatar_image_token column

Revision ID: 0003_user_avatar_image_token
Revises: 0002_room_image_token
Create Date: 2026-06-06

Cache-bust token for self-uploaded user avatars. The file lives at
`backend/data/uploads/users/{user_id}.webp`; the token changes on
every successful upload so member browsers refetch.

Nullable. Existing users keep the existing `avatar_url` (which may
point at an external URL, internal upload, or null).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0003_user_avatar_image_token"
down_revision: str | None = "0002_room_image_token"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("avatar_image_token", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "avatar_image_token")
