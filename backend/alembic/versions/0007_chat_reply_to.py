"""chat_messages.reply_to_id

Revision ID: 0007_chat_reply_to
Revises: 0006_chat_attachment
Create Date: 2026-06-06

Optional foreign key on chat_messages pointing at the parent message
this one is replying to. Null = top-level message. Powers the
iMessage / WhatsApp-style quoted-preview UI in the bubble.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0007_chat_reply_to"
down_revision: str | None = "0006_chat_attachment"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column(
            "reply_to_id",
            sa.String(),
            sa.ForeignKey("chat_messages.id"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "reply_to_id")
