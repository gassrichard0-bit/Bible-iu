"""Daily reading-plan reminder scheduler.

Runs as an asyncio task started by the FastAPI lifespan. Every
SCAN_INTERVAL_SEC it sweeps `reading_plan_enrollments` and pushes a
"Today's reading: ..." notification when:

  - The user's local clock is past `REMINDER_LOCAL_HOUR`
  - We haven't already reminded today (last_reminded_date != local today)
  - The user hasn't already completed today's reading

Timezone comes from `user.preferences["ui"]["timezone"]` (IANA name);
falls back to UTC when blank.

Single-instance only. Multi-instance deployments should swap this for
a real job queue (Cloud Tasks, Celery beat, etc.) with row-level
locking to avoid double-firing.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select

from ..data import get_session
from ..data.models import (
    ReadingPlanEnrollment,
    ReadingPlanProgress,
    User,
)
from . import reading_plans
from .push import send_push_to_user

log = logging.getLogger("bible_iu.reading_plan_scheduler")

# 8 AM is the standard morning-devotion slot. Coarser than per-user
# preference but simple — once we add a Settings picker we'll read it
# off the user's preferences here instead.
REMINDER_LOCAL_HOUR = 8

# How often the loop wakes up. 5 minutes is fine for hourly precision
# and keeps the CPU cost negligible on a single-instance deploy.
SCAN_INTERVAL_SEC = 5 * 60

_task: asyncio.Task | None = None


def _user_tz(user: User) -> ZoneInfo:
    """Pull the user's IANA timezone out of preferences; fall back to
    UTC when missing or invalid so the scheduler never crashes on a
    bad pref value."""
    prefs = dict(user.preferences or {})
    ui = prefs.get("ui", {}) or {}
    name = (ui.get("timezone") or "").strip()
    if not name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001
        return ZoneInfo("UTC")


def _current_day_index(enrollment: ReadingPlanEnrollment) -> int:
    """1-indexed day of the plan the user is on today (UTC-based,
    matching the GET /today endpoint's math)."""
    started = enrollment.started_at
    if started.tzinfo is None:
        # Old rows came in naive UTC; treat them as such.
        from datetime import timezone as _tz
        started = started.replace(tzinfo=_tz.utc)
    now = datetime.now(started.tzinfo)
    return max(1, (now - started).days + 1)


def _sweep_once() -> int:
    """Single pass through all enrollments. Returns push count for
    logging visibility. Holds its own DB session so the loop isn't
    tangled with request lifecycles."""
    sent = 0
    session = get_session()
    try:
        rows = list(session.scalars(select(ReadingPlanEnrollment)))
        for enrollment in rows:
            user = session.get(User, enrollment.user_id)
            if user is None:
                continue
            tz = _user_tz(user)
            local_now = datetime.now(tz)
            if local_now.hour < REMINDER_LOCAL_HOUR:
                continue
            today_str = local_now.date().isoformat()
            if enrollment.last_reminded_date == today_str:
                continue
            day_index = _current_day_index(enrollment)
            try:
                plan_length = len(reading_plans.PLANS[enrollment.plan_id])
            except KeyError:
                continue
            if day_index > plan_length:
                # Past the end of the plan — no more reminders.
                continue
            # Skip if today's reading is already done.
            done = session.scalar(
                select(ReadingPlanProgress).where(
                    ReadingPlanProgress.user_id == enrollment.user_id,
                    ReadingPlanProgress.plan_id == enrollment.plan_id,
                    ReadingPlanProgress.day_index == day_index,
                )
            )
            if done is not None:
                enrollment.last_reminded_date = today_str
                continue
            try:
                refs = reading_plans.plan_day(enrollment.plan_id, day_index)
            except IndexError:
                continue
            plan_meta = reading_plans.plan_summary(enrollment.plan_id)
            plan_name = plan_meta.get("name") or enrollment.plan_id
            preview = ", ".join(refs[:3]) + ("…" if len(refs) > 3 else "")
            payload: dict[str, Any] = {
                "kind": "reading_plan",
                "plan_id": enrollment.plan_id,
                "room_name": plan_name,
                "sender": f"Day {day_index}",
                "body": f"Today's reading: {preview}",
                "url": "/?tab=bible",
            }
            n = send_push_to_user(session, enrollment.user_id, payload)
            if n > 0:
                enrollment.last_reminded_date = today_str
                sent += n
        try:
            session.commit()
        except Exception:  # noqa: BLE001
            session.rollback()
    finally:
        session.close()
    return sent


async def _loop() -> None:
    log.info(
        "reading-plan scheduler started (hour=%s interval=%ss)",
        REMINDER_LOCAL_HOUR, SCAN_INTERVAL_SEC,
    )
    # Sweep right away so a startup near the reminder hour doesn't
    # wait a full interval before firing.
    while True:
        try:
            loop = asyncio.get_event_loop()
            n = await loop.run_in_executor(None, _sweep_once)
            if n:
                log.info("daily reminder sweep pushed %d notifications", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("reading-plan scheduler sweep crashed: %s", e)
        try:
            await asyncio.sleep(SCAN_INTERVAL_SEC)
        except asyncio.CancelledError:
            raise


async def startup() -> None:
    """Spin up the loop. Called from the FastAPI lifespan."""
    global _task
    if _task is not None and not _task.done():
        return
    _task = asyncio.create_task(_loop(), name="reading-plan-scheduler")


async def shutdown() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    _task = None
