"""chat_reactions table

Revision ID: 0008_chat_reactions
Revises: 0007_chat_reply_to
Create Date: 2026-06-06

iMessage / WhatsApp-style emoji reactions on chat messages. Unique
on (message_id, user_id, emoji) — a user can stack different emojis
on the same message but can't apply the same one twice.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0008_chat_reactions"
down_revision: str | None = "0007_chat_reply_to"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "chat_reactions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "message_id",
            sa.String(),
            sa.ForeignKey("chat_messages.id"),
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
        sa.Column("emoji", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("message_id", "user_id", "emoji"),
    )


def downgrade() -> None:
    op.drop_table("chat_reactions")
