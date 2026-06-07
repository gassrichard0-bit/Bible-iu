"""push_subscriptions table

Revision ID: 0009_push_subscriptions
Revises: 0008_chat_reactions
Create Date: 2026-06-07

Stores Web Push endpoints per user so chat/notes events can wake the
phone (PWA installed to home screen on iOS, any Chrome on Android).
Endpoint is unique — re-subscribing on the same device upserts.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0009_push_subscriptions"
down_revision: str | None = "0008_chat_reactions"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("endpoint", sa.String(), nullable=False),
        sa.Column("p256dh", sa.String(), nullable=False),
        sa.Column("auth", sa.String(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("endpoint"),
    )


def downgrade() -> None:
    op.drop_table("push_subscriptions")
