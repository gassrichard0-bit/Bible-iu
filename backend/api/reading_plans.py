"""Hard-coded reading plan registry.

Plans live in code (not the DB) because their content is static —
they don't get edited by users or admins. Enrollment + progress
state lives in SQL (`ReadingPlanEnrollment`, `ReadingPlanProgress`).

A "day" is a list of passage references (OSIS-style `BOOK.CH.V`,
ranges allowed: `JHN.3.16-21` or whole chapters `PSA.1`). The
backend just hands these strings to the frontend, which expands them
into clickable verse anchors. No server-side parsing required for
this MVP.

Add a new plan by appending to `PLANS` and giving it a unique slug.
"""
from __future__ import annotations

from typing import Iterable


def _psalm_a_day() -> list[list[str]]:
    """One Psalm per day, 150 days. Psalm 119 is split into 22 days
    because it's the longest chapter in the Bible (one stanza per
    day; 8 verses each)."""
    days: list[list[str]] = []
    for n in range(1, 151):
        if n != 119:
            days.append([f"PSA.{n}"])
    # Psalm 119 stanzas (1–8, 9–16, …, 169–176).
    p119_days = [
        f"PSA.119.{a}-{a + 7}" for a in range(1, 177, 8)
    ]
    # Insert in canonical order — Psalm 119 follows 118.
    insert_at = next(
        i for i, d in enumerate(days) if d[0] == "PSA.120"
    )
    days = days[:insert_at] + [[d] for d in p119_days] + days[insert_at:]
    return days


def _nt_in_90() -> list[list[str]]:
    """The New Testament in 90 days. Each day is ~3 chapters.
    Built by walking the canonical NT in order and chunking into
    roughly equal daily portions (260 chapters / 90 days ≈ 2.89).
    """
    nt_books: list[tuple[str, int]] = [
        ("MAT", 28), ("MRK", 16), ("LUK", 24), ("JHN", 21),
        ("ACT", 28), ("ROM", 16),
        ("1CO", 16), ("2CO", 13),
        ("GAL", 6), ("EPH", 6), ("PHP", 4), ("COL", 4),
        ("1TH", 5), ("2TH", 3),
        ("1TI", 6), ("2TI", 4),
        ("TIT", 3), ("PHM", 1), ("HEB", 13),
        ("JAS", 5), ("1PE", 5), ("2PE", 3),
        ("1JN", 5), ("2JN", 1), ("3JN", 1),
        ("JUD", 1), ("REV", 22),
    ]
    chapters: list[str] = []
    for code, count in nt_books:
        for ch in range(1, count + 1):
            chapters.append(f"{code}.{ch}")
    n_days = 90
    per_day, extras = divmod(len(chapters), n_days)
    out: list[list[str]] = []
    idx = 0
    for d in range(n_days):
        count = per_day + (1 if d < extras else 0)
        out.append(chapters[idx : idx + count])
        idx += count
    return out


def _bible_in_a_year() -> list[list[str]]:
    """Whole Bible in 365 days — 3-4 chapters/day, OT + NT in parallel.
    OT chapters split across 365 days; NT chapters layered every
    fourth day. Compact instead of canonical — readability for an
    MVP plan; better plans (M'Cheyne, etc.) can come later."""
    ot_books: list[tuple[str, int]] = [
        ("GEN", 50), ("EXO", 40), ("LEV", 27), ("NUM", 36), ("DEU", 34),
        ("JOS", 24), ("JDG", 21), ("RUT", 4),
        ("1SA", 31), ("2SA", 24), ("1KI", 22), ("2KI", 25),
        ("1CH", 29), ("2CH", 36), ("EZR", 10), ("NEH", 13), ("EST", 10),
        ("JOB", 42), ("PSA", 150), ("PRO", 31), ("ECC", 12), ("SNG", 8),
        ("ISA", 66), ("JER", 52), ("LAM", 5), ("EZK", 48), ("DAN", 12),
        ("HOS", 14), ("JOL", 3), ("AMO", 9), ("OBA", 1), ("JON", 4),
        ("MIC", 7), ("NAM", 3), ("HAB", 3), ("ZEP", 3),
        ("HAG", 2), ("ZEC", 14), ("MAL", 4),
    ]
    nt = _nt_in_90()
    nt_flat = [ch for day in nt for ch in day]

    ot_chapters: list[str] = []
    for code, count in ot_books:
        for ch in range(1, count + 1):
            ot_chapters.append(f"{code}.{ch}")

    days: list[list[str]] = []
    ot_per_day = max(1, len(ot_chapters) // 365)
    ot_extras = len(ot_chapters) - ot_per_day * 365
    ot_idx = 0
    nt_idx = 0
    for d in range(365):
        chunk = ot_per_day + (1 if d < ot_extras else 0)
        day = ot_chapters[ot_idx : ot_idx + chunk]
        ot_idx += chunk
        if d % 4 == 0 and nt_idx < len(nt_flat):
            day.append(nt_flat[nt_idx])
            nt_idx += 1
        days.append(day)
    return days


PLANS: dict[str, dict] = {
    "psalm-a-day": {
        "name": "A Psalm a day",
        "summary": "One Psalm per day for ~5 months. Psalm 119 split into stanzas.",
        "days": _psalm_a_day(),
    },
    "nt-in-90": {
        "name": "New Testament in 90 days",
        "summary": "Three chapters a day, ninety days from Matthew through Revelation.",
        "days": _nt_in_90(),
    },
    "bible-in-a-year": {
        "name": "Bible in a year",
        "summary": "OT walk-through with the New Testament layered every fourth day.",
        "days": _bible_in_a_year(),
    },
}


def plan_ids() -> Iterable[str]:
    return PLANS.keys()


def plan_summary(plan_id: str) -> dict:
    plan = PLANS[plan_id]
    return {
        "id": plan_id,
        "name": plan["name"],
        "summary": plan["summary"],
        "length_days": len(plan["days"]),
    }


def plan_day(plan_id: str, day_index: int) -> list[str]:
    """1-indexed day → list of reference strings. Out-of-range
    indexes raise IndexError, which the endpoint maps to 404."""
    plan = PLANS[plan_id]
    if day_index < 1 or day_index > len(plan["days"]):
        raise IndexError(day_index)
    return list(plan["days"][day_index - 1])
