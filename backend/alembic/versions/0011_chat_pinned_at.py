"""chat_messages.pinned_at

Revision ID: 0011_chat_pinned_at
Revises: 0010_enrollment_reminder
Create Date: 2026-06-08

Adds the `pinned_at` column so admins can pin chat messages to the top
of a room (announcements, verse-of-the-day, etc.). NULL = not pinned;
otherwise the timestamp records when the pin happened, used to order
multiple pins by recency.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0011_chat_pinned_at"
down_revision: str | None = "0010_enrollment_reminder"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("chat_messages") as batch:
        batch.add_column(sa.Column("pinned_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("chat_messages") as batch:
        batch.drop_column("pinned_at")
