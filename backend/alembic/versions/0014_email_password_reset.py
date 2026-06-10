"""users.email + password_reset_tokens

Revision ID: 0014_email_password_reset
Revises: 0013_note_like_kind
Create Date: 2026-06-10

Email-based password reset:

* `users.email` — optional, unique-when-set. SQLite allows multiple
  NULL values through a unique constraint, so the "unique only when
  the user has set an email" semantics fall out of the schema.
* `users.email_verified_at` — null until a future verification flow
  flips it. Not gated tonight; just future-proofs the trust signal.
* `password_reset_tokens` — one-shot link the user requested via
  `/auth/forgot-password`. We store a SHA256 of the token so a SQL
  leak doesn't surface usable links.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0014_email_password_reset"
down_revision: str | None = "0013_note_like_kind"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("email", sa.String(), nullable=True))
        batch.add_column(sa.Column("email_verified_at", sa.DateTime(), nullable=True))
        batch.create_index("ix_users_email", ["email"], unique=True)

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_password_reset_tokens_hash"),
    )
    op.create_index(
        "ix_password_reset_tokens_token_hash",
        "password_reset_tokens",
        ["token_hash"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_password_reset_tokens_token_hash",
        table_name="password_reset_tokens",
    )
    op.drop_table("password_reset_tokens")
    with op.batch_alter_table("users") as batch:
        batch.drop_index("ix_users_email")
        batch.drop_column("email_verified_at")
        batch.drop_column("email")
