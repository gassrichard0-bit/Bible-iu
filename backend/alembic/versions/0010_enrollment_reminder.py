"""reading_plan_enrollments.last_reminded_date

Revision ID: 0010_enrollment_reminder
Revises: 0009_push_subscriptions
Create Date: 2026-06-07

Tracks the last YYYY-MM-DD (user-local) we pushed a daily reading
reminder for each enrollment so the scheduler can't double-remind on
restart and skips rows where today's reading is already done.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0010_enrollment_reminder"
down_revision: str | None = "0009_push_subscriptions"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("reading_plan_enrollments") as batch:
        batch.add_column(sa.Column("last_reminded_date", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("reading_plan_enrollments") as batch:
        batch.drop_column("last_reminded_date")
