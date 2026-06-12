"""archive deleted chat messages + notes

Revision ID: 0019_archive_deleted
Revises: 0018_note_mentions_updated_at
Create Date: 2026-06-11

When a user taps Delete on a chat message or a note, the row vanishes
for everyone in the room — but instead of being purged from disk, a
copy lands here. Richard can recover anything by querying the archive
tables directly (sqlite3 backend/data/app.db). No FK back to the
originals; the originals are GONE by the time the archive row exists.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0019_archive_deleted"
down_revision: str | None = "0018_note_mentions_updated_at"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "archived_chat_messages",
        sa.Column("archive_id", sa.String(), primary_key=True),
        sa.Column("message_id", sa.String(), nullable=False, index=True),
        sa.Column("room_id", sa.String(), nullable=False, index=True),
        sa.Column("author_user_id", sa.String(), nullable=True),
        sa.Column("author_handle", sa.String(), nullable=True),
        sa.Column("author_display_name", sa.String(), nullable=True),
        sa.Column("author_is_agent", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("language", sa.String(), nullable=True),
        sa.Column("attachment_image_token", sa.String(), nullable=True),
        sa.Column("reply_to_id", sa.String(), nullable=True),
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("original_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("deleted_by_user_id", sa.String(), nullable=True),
    )

    op.create_table(
        "archived_notes",
        sa.Column("archive_id", sa.String(), primary_key=True),
        sa.Column("note_id", sa.String(), nullable=False, index=True),
        sa.Column("room_id", sa.String(), nullable=False, index=True),
        # "group" | "personal"
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("author_user_id", sa.String(), nullable=True),
        sa.Column("author_handle", sa.String(), nullable=True),
        sa.Column("by_agent", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("verse_anchor", sa.String(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("deleted_by_user_id", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("archived_notes")
    op.drop_table("archived_chat_messages")
