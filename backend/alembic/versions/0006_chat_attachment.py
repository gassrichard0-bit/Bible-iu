"""chat_messages.attachment_image_token

Revision ID: 0006_chat_attachment
Revises: 0005_room_member_last_read
Create Date: 2026-06-06

Optional image attachment per chat message. Token is the cache-bust
value used by `GET /rooms/{room_id}/chat/{message_id}/image?v=...`.
File lives at `backend/data/uploads/chat/{message_id}.webp`.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0006_chat_attachment"
down_revision: str | None = "0005_room_member_last_read"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("attachment_image_token", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "attachment_image_token")
